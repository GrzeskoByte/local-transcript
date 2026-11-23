//! lt-server — self-hosted, multi-user edition (`docs/SERVER.md`).
mod accounts_db;
mod admin;
mod auth;
mod config;
mod ctx;
mod http;
mod users;

use anyhow::Result;
use clap::{Parser, Subcommand};

use accounts_db::{AccountsDb, Role};
use auth::local;
use config::Config;
use ctx::App;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the HTTP server (default).
    Serve,
    /// Manage local accounts from the server console.
    Admin {
        #[command(subcommand)]
        command: AdminCommand,
    },
}

#[derive(Subcommand)]
enum AdminCommand {
    Create {
        #[arg(long)]
        email: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        password: String,
        #[arg(long, value_enum, default_value = "member")]
        role: Role,
    },
    ResetPassword {
        #[arg(long)]
        email: String,
        #[arg(long)]
        password: String,
    },
    List,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(Config::load()?).await,
        Command::Admin { command } => {
            let db = AccountsDb::open(&config::data_dir())?;
            admin_command(db, command).await
        }
    }
}

async fn serve(mut config: Config) -> Result<()> {
    let db = AccountsDb::open(&config.engine.data_dir)?;
    if let Some((email, password)) = config.bootstrap.take() {
        let name = email.split('@').next().unwrap_or("Admin").trim().to_owned();
        local::create_account(&db, email, name, password, Role::Admin, true).await?;
    }
    let app = App::new(config, db)?;
    let listener = tokio::net::TcpListener::bind(app.config.bind).await?;
    eprintln!(
        "lt-server {} listening on {}",
        env!("CARGO_PKG_VERSION"),
        listener.local_addr()?
    );
    axum::serve(
        listener,
        http::router(app).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn admin_command(db: AccountsDb, command: AdminCommand) -> Result<()> {
    match command {
        AdminCommand::Create {
            email,
            name,
            password,
            role,
        } => {
            if let Some(user) =
                local::create_account(&db, email, name, password, role, false).await?
            {
                println!("Created {} ({})", user.email, user.role.as_str());
            }
        }
        AdminCommand::ResetPassword { email, password } => {
            local::reset_password(&db, email, password).await?;
            println!("Password reset");
        }
        AdminCommand::List => {
            let users = db.run(|db| accounts_db::list_users(db)).await?;
            for user in users {
                let status = if user.disabled { "disabled" } else { "active" };
                println!(
                    "{}\t{}\t{}",
                    user.profile.email,
                    user.profile.role.as_str(),
                    status
                );
            }
        }
    }
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = terminate.recv() => {},
                }
            }
            Err(error) => {
                eprintln!("lt-server: could not register SIGTERM handler: {error}");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests;
