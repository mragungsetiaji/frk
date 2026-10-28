use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Starting git, or reading or writing a file, failed.
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("git {args} failed: {stderr}")]
    Git { args: String, stderr: String },
    #[error("not a git repository: {0}")]
    NotARepo(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Field and record separators used in every `--format` we ask git for. Commit
/// subjects can contain tabs and NULs never survive a format string, so the
/// ASCII unit/record separators are the safe pair.
pub const FS: char = '\x1f';
pub const RS: char = '\x1e';

#[derive(Debug, Clone)]
pub struct Repo {
    root: PathBuf,
}

impl Repo {
    /// Opens the repository containing `path`, resolving to its top level.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let out = base_command()
            .arg("-C")
            .arg(path)
            .args(["rev-parse", "--show-toplevel"])
            .output()?;
        if !out.status.success() {
            return Err(Error::NotARepo(path.display().to_string()));
        }
        let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(Self {
            root: PathBuf::from(root),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Runs git and returns stdout, treating a non-zero exit as an error.
    pub fn run<I, S>(&self, args: I) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args = collect(args);
        let out = self.command(&args).output()?;
        check(&args, out)
    }

    /// Runs git and returns `None` on a non-zero exit, for queries where failure
    /// only means "absent" (a ref that does not exist, a symref that is unset).
    pub fn try_run<I, S>(&self, args: I) -> Result<Option<String>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args = collect(args);
        let out = self.command(&args).output()?;
        Ok(out
            .status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned()))
    }

    /// Runs git with `input` on stdin. Used to hand `git log --stdin` hundreds of
    /// tips without running into the Windows command-line length limit.
    pub fn run_with_stdin<I, S>(&self, args: I, input: &str) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args = collect(args);
        let mut child = self
            .command(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        // Write on a separate thread: a large stdout can fill its pipe before we
        // finish writing stdin, and doing both on one thread would deadlock.
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let input = input.to_owned();
        let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
        let out = child.wait_with_output()?;
        writer.join().expect("stdin writer panicked")?;
        check(&args, out)
    }

    fn command(&self, args: &[OsString]) -> Command {
        let mut cmd = base_command();
        cmd.arg("-C").arg(&self.root).args(args);
        cmd
    }
}

fn base_command() -> Command {
    let mut cmd = Command::new("git");
    cmd.args([
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=false",
        "--no-pager",
    ])
    // Never block on a credential prompt nobody can see; fail instead.
    .env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn collect<I, S>(args: I) -> Vec<OsString>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter().map(|a| a.as_ref().to_owned()).collect()
}

fn check(args: &[OsString], out: Output) -> Result<String> {
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(Error::Git {
        args: args
            .iter()
            .map(|a| a.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" "),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}
