//! Incremental JSONL reading shared by transcript-based harnesses.
//!
//! A file read for the first time is read whole when small; otherwise only
//! its head and tail are read. Later reads return the lines appended since
//! the stored byte offset. A file that shrinks is read again from the start.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

pub const HEAD_BYTES: u64 = 64 * 1024;
pub const TAIL_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Default)]
pub struct Cursor {
    offset: u64,
    len: u64,
    mtime: Option<SystemTime>,
}

#[derive(Debug, Default)]
pub struct Update {
    /// The file shrank: state built from earlier lines is void.
    pub reset: bool,
    pub lines: Vec<Vec<u8>>,
}

/// Push every complete line of `buf` to `out`; returns the bytes consumed
/// (up to and including the last newline).
fn split(buf: &[u8], skip_partial_first: bool, out: &mut Vec<Vec<u8>>) -> u64 {
    let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') else {
        return 0;
    };
    let mut lines = buf[..=last_nl].split(|b| *b == b'\n');
    if skip_partial_first {
        lines.next();
    }
    out.extend(lines.filter(|l| !l.is_empty()).map(<[u8]>::to_vec));
    last_nl as u64 + 1
}

impl Cursor {
    pub fn mtime(&self) -> Option<SystemTime> {
        self.mtime
    }

    /// Lines added since the last call, or `None` when the file is unchanged.
    pub fn read(&mut self, path: &Path) -> std::io::Result<Option<Update>> {
        let meta = std::fs::metadata(path)?;
        let len = meta.len();
        let mtime = meta.modified().ok();
        if len == self.len && mtime == self.mtime {
            return Ok(None);
        }
        let reset = len < self.len;
        if reset {
            *self = Cursor::default();
        }
        let mut f = File::open(path)?;
        let mut lines = Vec::new();
        if self.offset == 0 && len > HEAD_BYTES + TAIL_BYTES {
            let mut head = vec![0u8; HEAD_BYTES as usize];
            f.read_exact(&mut head)?;
            split(&head, false, &mut lines);
            let tail_start = len - TAIL_BYTES;
            f.seek(SeekFrom::Start(tail_start))?;
            let mut tail = Vec::with_capacity(TAIL_BYTES as usize);
            f.read_to_end(&mut tail)?;
            self.offset = tail_start + split(&tail, true, &mut lines);
        } else {
            f.seek(SeekFrom::Start(self.offset))?;
            let mut rest = Vec::with_capacity(len.saturating_sub(self.offset) as usize);
            f.read_to_end(&mut rest)?;
            self.offset += split(&rest, false, &mut lines);
        }
        self.len = len;
        self.mtime = mtime;
        Ok(Some(Update { reset, lines }))
    }
}

/// Text of a chat message `content`: a string, or the first `text` block
/// of an array.
pub fn message_text(content: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    match content {
        Value::String(t) => Some(t.clone()),
        Value::Array(items) => items.iter().find_map(|i| {
            (i.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| i.get("text").and_then(Value::as_str).map(str::to_string))
                .flatten()
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_appended_lines_and_resets_on_shrink() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("s.jsonl");
        std::fs::write(&p, "a\nb\npartial").unwrap();
        let mut c = Cursor::default();
        let u = c.read(&p).unwrap().unwrap();
        assert_eq!(u.lines, vec![b"a".to_vec(), b"b".to_vec()]);
        assert!(c.read(&p).unwrap().is_none());

        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"-done\nc\n").unwrap();
        drop(f);
        let u = c.read(&p).unwrap().unwrap();
        assert!(!u.reset);
        assert_eq!(u.lines, vec![b"partial-done".to_vec(), b"c".to_vec()]);

        std::fs::write(&p, "z\n").unwrap();
        let u = c.read(&p).unwrap().unwrap();
        assert!(u.reset);
        assert_eq!(u.lines, vec![b"z".to_vec()]);
    }

    #[test]
    fn resets_when_truncated_inside_an_unfinished_line() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("session.jsonl");
        std::fs::write(&path, "a\npartial-data").unwrap();
        let mut cursor = Cursor::default();
        assert_eq!(cursor.read(&path).unwrap().unwrap().lines, vec![b"a".to_vec()]);

        std::fs::write(&path, "b\nx").unwrap();
        let update = cursor.read(&path).unwrap().unwrap();
        assert!(update.reset);
        assert_eq!(update.lines, vec![b"b".to_vec()]);
    }
}
