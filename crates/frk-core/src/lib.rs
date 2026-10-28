//! Read model behind frk: every ref in a repository, the commit graph across all
//! of them, commit detail, and a "since you last looked" snapshot of the refs.
//!
//! Everything here shells out to the git CLI rather than linking a git library.
//! That keeps the user's own config, credential helpers, SSH agent, hooks and
//! the `commit-graph` file in play without reimplementing any of them, and
//! `git log` over a few thousand commits is far below what the UI can notice.
//! If the walk ever becomes the bottleneck on a very large repository, `graph`
//! is the one module worth moving onto gitoxide.

pub mod actions;
pub mod detail;
pub mod file;
pub mod git;
pub mod graph;
pub mod refs;
pub mod snapshot;

pub use git::{Error, Repo, Result};
