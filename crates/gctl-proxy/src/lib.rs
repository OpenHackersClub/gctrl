//! MITM proxy for agent traffic interception.
//! Phase 2: Will use `hudsucker` for transparent HTTP(S) proxying.

pub struct ProxyServer {
    port: u16,
}

impl ProxyServer {
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_proxy_creation() {
        let proxy = ProxyServer::new(8080);
        assert_eq!(proxy.port(), 8080);
    }
}
