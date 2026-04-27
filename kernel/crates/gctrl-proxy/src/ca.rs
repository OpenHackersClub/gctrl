//! CA certificate bootstrap. Generates a self-signed CA on first run and
//! locks file permissions (key 0600, directory 0700) so other users on a
//! shared machine can't grab the private key.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use hudsucker::rcgen;

pub struct CaPaths {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

pub fn ensure_ca_cert(dir: &Path) -> Result<CaPaths> {
    let cert_path = dir.join("ca.cer");
    let key_path = dir.join("ca.key");

    if cert_path.exists() && key_path.exists() {
        // Be defensive — an existing key with loose perms should be tightened.
        tighten_perms(dir, &key_path)?;
        return Ok(CaPaths {
            cert_path,
            key_path,
        });
    }

    std::fs::create_dir_all(dir)
        .with_context(|| format!("create CA dir {}", dir.display()))?;

    let mut params = rcgen::CertificateParams::new(vec!["gctrl proxy CA".to_string()])
        .context("init cert params")?;
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "gctrl proxy CA");
    params
        .distinguished_name
        .push(rcgen::DnType::OrganizationName, "gctrl");

    let key_pair = rcgen::KeyPair::generate().context("generate CA key")?;
    let cert = params.self_signed(&key_pair).context("self-sign CA")?;

    std::fs::write(&key_path, key_pair.serialize_pem())
        .with_context(|| format!("write CA key {}", key_path.display()))?;
    std::fs::write(&cert_path, cert.pem())
        .with_context(|| format!("write CA cert {}", cert_path.display()))?;

    tighten_perms(dir, &key_path)?;

    tracing::info!("generated proxy CA at {}", cert_path.display());

    Ok(CaPaths {
        cert_path,
        key_path,
    })
}

#[cfg(unix)]
fn tighten_perms(dir: &Path, key_path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let dir_perms = std::fs::Permissions::from_mode(0o700);
    let key_perms = std::fs::Permissions::from_mode(0o600);
    let _ = std::fs::set_permissions(dir, dir_perms);
    let _ = std::fs::set_permissions(key_path, key_perms);
    Ok(())
}

#[cfg(not(unix))]
fn tighten_perms(_dir: &Path, _key_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ensure_creates_ca_files() {
        let tmp = TempDir::new().unwrap();
        let paths = ensure_ca_cert(tmp.path()).unwrap();
        assert!(paths.cert_path.exists());
        assert!(paths.key_path.exists());
    }

    #[test]
    fn ensure_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        let first = ensure_ca_cert(tmp.path()).unwrap();
        let cert_a = std::fs::read_to_string(&first.cert_path).unwrap();
        let second = ensure_ca_cert(tmp.path()).unwrap();
        let cert_b = std::fs::read_to_string(&second.cert_path).unwrap();
        assert_eq!(cert_a, cert_b, "second call must reuse existing CA");
    }

    #[cfg(unix)]
    #[test]
    fn ensure_locks_key_perms() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let paths = ensure_ca_cert(tmp.path()).unwrap();
        let mode = std::fs::metadata(&paths.key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "CA key must be 0600, got {mode:o}");
    }
}
