//! Running jobs per user (ASR / live): a cancel flag + the child process, so a
//! cancel only ever reaches the caller's own jobs.
use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::util::lock;

pub struct JobCtl {
    pub cancelled: AtomicBool,
    pub child: Mutex<Option<Child>>,
}

impl JobCtl {
    fn new() -> Arc<Self> {
        Arc::new(Self { cancelled: AtomicBool::new(false), child: Mutex::new(None) })
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Flag the job and kill its child (the job's thread notices on its next poll).
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(mut child) = lock(&self.child).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Cancels the job when the owning future is dropped (the HTTP request went away).
pub struct CancelOnDrop(pub Arc<JobCtl>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Vec<Arc<JobCtl>>>>,
}

/// Registered job; dropping it unregisters it and kills a child still running
/// (e.g. the HTTP request went away).
pub struct JobGuard {
    registry: Arc<JobRegistry>,
    user: String,
    pub ctl: Arc<JobCtl>,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.ctl.cancel();
        let mut jobs = lock(&self.registry.jobs);
        if let Some(list) = jobs.get_mut(&self.user) {
            list.retain(|c| !Arc::ptr_eq(c, &self.ctl));
            if list.is_empty() {
                jobs.remove(&self.user);
            }
        }
    }
}

impl JobRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Register a job unless `max_total` jobs run in all or `max_per_user` for this user.
    pub fn try_register(self: &Arc<Self>, user: &str, max_total: usize, max_per_user: usize) -> Option<JobGuard> {
        let mut jobs = lock(&self.jobs);
        let total: usize = jobs.values().map(Vec::len).sum();
        let mine = jobs.get(user).map(Vec::len).unwrap_or(0);
        if total >= max_total || mine >= max_per_user {
            return None;
        }
        let ctl = JobCtl::new();
        jobs.entry(user.to_string()).or_default().push(ctl.clone());
        Some(JobGuard { registry: self.clone(), user: user.to_string(), ctl })
    }

    pub fn register(self: &Arc<Self>, user: &str) -> JobGuard {
        self.try_register(user, usize::MAX, usize::MAX).expect("unlimited")
    }

    /// Cancel every job of `user` (and only theirs); returns how many.
    pub fn cancel_user(&self, user: &str) -> usize {
        let list: Vec<Arc<JobCtl>> = lock(&self.jobs).get(user).cloned().unwrap_or_default();
        for ctl in &list {
            ctl.cancel();
        }
        list.len()
    }

}
