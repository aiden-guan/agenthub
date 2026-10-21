//! Sample Rust crate for the outline tests (and the mapping property test).

use std::fmt;
use std::collections::{HashMap, HashSet};
extern crate serde;

// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration
/// Logs a user in.
pub fn login(user: &str, password: &str) -> Result<Session, Error> {
    authenticate(user, password)
}

// A detached note about the crate.

mod external;

/// A session.
#[derive(Debug, Clone)]
pub struct Session<T> {
    id: String,
    store: T,
}

impl<T: Store + Send> Session<T> {
    /// How long a session lives.
    pub const TTL: u64 = 3600;

    pub fn new(store: T) -> Self {
        Session { id: String::new(), store }
    }

    #[inline]
    pub fn refresh(&mut self, force: bool) -> Result<(), Error> {
        self.store.rotate(force)
    }
}

impl<T> fmt::Display for Session<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.id)
    }
}

impl Refresh for Session<String> {
    fn refresh(&mut self, force: bool) -> Result<(), Error> {
        Ok(())
    }
}

pub trait Store {
    type Key;
    const LIMIT: usize;
    fn get(&self, id: &str) -> Option<Self::Key>;
    fn rotate(&mut self, force: bool) -> Result<(), Error> {
        Ok(())
    }
}

pub enum Role {
    Admin,
    User(u32),
}

pub type Res<T> = std::result::Result<T, Error>;

static COUNT: AtomicUsize = AtomicUsize::new(0);

pub mod auth {
    use super::*;

    pub fn check(token: &'static str) -> bool {
        !token.is_empty()
    }
}

macro_rules! log {
    ($($t:tt)*) => {};
}

fn r#match() {}
