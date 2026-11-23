//! Fair job queue: at most `capacity` jobs run at once; waiting jobs are taken
//! round-robin across users, so one user's backlog never starves the others.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::util::lock;

/// Held while a job runs; dropping it hands the slot to the next waiter.
pub struct Permit {
    queue: Arc<FairQueue>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.queue.release();
    }
}

/// The waiter was cancelled (`cancel_user`) before its turn.
#[derive(Debug, PartialEq)]
pub struct Cancelled;

pub enum Entry {
    /// A slot was free.
    Ready(Permit),
    /// Queued; resolves to the permit on this job's turn.
    Waiting(oneshot::Receiver<Permit>),
}

impl Entry {
    pub async fn wait(self) -> Result<Permit, Cancelled> {
        match self {
            Entry::Ready(permit) => Ok(permit),
            Entry::Waiting(rx) => rx.await.map_err(|_| Cancelled),
        }
    }
}

struct Waiter {
    tx: oneshot::Sender<Permit>,
}

#[derive(Default)]
struct Inner {
    running: usize,
    waiting: HashMap<String, VecDeque<Waiter>>,
    /// Users that have waiters, in the order their next job is taken.
    rotation: VecDeque<String>,
}

pub struct FairQueue {
    capacity: usize,
    inner: Mutex<Inner>,
}

impl FairQueue {
    pub fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self { capacity: capacity.max(1), inner: Mutex::new(Inner::default()) })
    }

    pub fn enter(self: &Arc<Self>, user: &str) -> Entry {
        let mut inner = lock(&self.inner);
        if inner.running < self.capacity && inner.rotation.is_empty() {
            inner.running += 1;
            return Entry::Ready(Permit { queue: self.clone() });
        }
        let (tx, rx) = oneshot::channel();
        let queue = inner.waiting.entry(user.to_string()).or_default();
        if queue.is_empty() {
            inner.rotation.push_back(user.to_string());
        }
        inner.waiting.get_mut(user).expect("just inserted").push_back(Waiter { tx });
        Entry::Waiting(rx)
    }

    fn release(self: &Arc<Self>) {
        let next = {
            let mut inner = lock(&self.inner);
            inner.running = inner.running.saturating_sub(1);
            self.take_next(&mut inner)
        };
        // Sent outside the lock: if the waiter is gone the permit comes back and
        // dropping it releases the slot again (to the next one).
        if let Some(waiter) = next {
            let _ = waiter.tx.send(Permit { queue: self.clone() });
        }
    }

    fn take_next(&self, inner: &mut Inner) -> Option<Waiter> {
        if inner.running >= self.capacity {
            return None;
        }
        let user = inner.rotation.pop_front()?;
        let queue = inner.waiting.get_mut(&user)?;
        let waiter = queue.pop_front()?;
        if queue.is_empty() {
            inner.waiting.remove(&user);
        } else {
            inner.rotation.push_back(user);
        }
        inner.running += 1;
        Some(waiter)
    }

    /// Drop every queued (not running) job of `user`; their waits end with `Cancelled`.
    pub fn cancel_user(&self, user: &str) -> usize {
        let mut inner = lock(&self.inner);
        inner.rotation.retain(|u| u != user);
        inner.waiting.remove(user).map(|q| q.len()).unwrap_or(0)
    }

    #[cfg(test)]
    pub fn running(&self) -> usize {
        lock(&self.inner).running
    }

    #[cfg(test)]
    pub fn queued(&self, user: &str) -> usize {
        lock(&self.inner).waiting.get(user).map(|q| q.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(e: Entry) -> Permit {
        match e {
            Entry::Ready(p) => p,
            Entry::Waiting(_) => panic!("expected a free slot"),
        }
    }

    fn waiting(e: Entry) -> oneshot::Receiver<Permit> {
        match e {
            Entry::Waiting(rx) => rx,
            Entry::Ready(_) => panic!("expected to queue"),
        }
    }

    /// Fake jobs: `(user, label)`. Runs them one at a time and returns the order.
    fn run_order(jobs: &[(&str, &str)], capacity: usize) -> Vec<String> {
        let q = FairQueue::new(capacity);
        let mut first = Vec::new();
        let mut rest: Vec<(String, oneshot::Receiver<Permit>)> = Vec::new();
        for (user, label) in jobs {
            match q.enter(user) {
                Entry::Ready(p) => first.push((label.to_string(), p)),
                Entry::Waiting(rx) => rest.push((label.to_string(), rx)),
            }
        }
        let mut order: Vec<String> = first.iter().map(|(l, _)| l.clone()).collect();
        let mut running: Vec<Permit> = first.into_iter().map(|(_, p)| p).collect();
        while !running.is_empty() {
            running.remove(0); // a job finished
            for (label, rx) in rest.iter_mut() {
                if let Ok(p) = rx.try_recv() {
                    order.push(label.clone());
                    running.push(p);
                }
            }
        }
        order
    }

    #[test]
    fn round_robins_across_users() {
        // A has a backlog of three, B and C one each: A cannot starve them.
        let order = run_order(&[("a", "a1"), ("a", "a2"), ("a", "a3"), ("a", "a4"), ("b", "b1"), ("c", "c1")], 1);
        assert_eq!(order, ["a1", "a2", "b1", "c1", "a3", "a4"]);
    }

    #[test]
    fn single_user_stays_in_order() {
        let order = run_order(&[("a", "1"), ("a", "2"), ("a", "3")], 1);
        assert_eq!(order, ["1", "2", "3"]);
    }

    #[test]
    fn a_newcomer_goes_after_the_users_already_waiting() {
        let q = FairQueue::new(1);
        let running = ready(q.enter("x"));
        let mut a1 = waiting(q.enter("a"));
        let mut a2 = waiting(q.enter("a"));
        let mut b1 = waiting(q.enter("b"));
        drop(running);
        let p1 = a1.try_recv().unwrap();
        assert!(a2.try_recv().is_err());
        assert!(b1.try_recv().is_err());
        drop(p1); // a1 done → b (waiting longer than a's second job) goes next
        let p2 = b1.try_recv().unwrap();
        assert!(a2.try_recv().is_err());
        drop(p2);
        assert!(a2.try_recv().is_ok());
    }

    #[test]
    fn capacity_allows_parallel_jobs() {
        let q = FairQueue::new(2);
        let _p1 = ready(q.enter("a"));
        let _p2 = ready(q.enter("b"));
        assert_eq!(q.running(), 2);
        let _w = waiting(q.enter("c"));
    }

    #[test]
    fn cancel_user_drops_only_their_waiting_jobs() {
        let q = FairQueue::new(1);
        let running = ready(q.enter("a"));
        let mut a2 = waiting(q.enter("a"));
        let mut b1 = waiting(q.enter("b"));
        assert_eq!(q.cancel_user("a"), 1);
        assert!(matches!(a2.try_recv(), Err(oneshot::error::TryRecvError::Closed)));
        assert_eq!(q.queued("b"), 1);
        drop(running);
        assert!(b1.try_recv().is_ok());
        assert_eq!(q.running(), 0);
    }

    #[test]
    fn a_waiter_that_went_away_does_not_leak_the_slot() {
        let q = FairQueue::new(1);
        let running = ready(q.enter("a"));
        let gone = waiting(q.enter("b"));
        let mut next = waiting(q.enter("c"));
        drop(gone);
        drop(running);
        assert!(next.try_recv().is_ok());
        assert_eq!(q.running(), 0);
    }
}
