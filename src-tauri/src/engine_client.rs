// HoloGram v4 Phase 0 — TCP client to Rust analysis engine
// Connects to the engine's JSON-RPC server, sends requests, receives responses.
// Format: 4-byte LE length prefix + JSON payload (both directions).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub struct EngineClient {
    addr: String,
}

impl EngineClient {
    pub fn new(addr: &str) -> Self {
        Self { addr: addr.to_string() }
    }

    /// Send a raw text command and receive the JSON response.
    /// Phase 0: simple request-response. Phase 1+ will add proper RPC framing.
    pub fn send(&self, command: &str) -> Result<String, String> {
        let mut stream = TcpStream::connect_timeout(
            &self.addr.parse().map_err(|e| format!("Invalid addr: {}", e))?,
            Duration::from_secs(5),
        )
        .map_err(|e| format!("Engine connect failed: {}", e))?;

        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();

        // Send request
        stream
            .write_all(command.as_bytes())
            .map_err(|e| format!("Engine write failed: {}", e))?;

        // Read 4-byte length prefix
        let mut len_buf = [0u8; 4];
        stream
            .read_exact(&mut len_buf)
            .map_err(|e| format!("Engine read length failed: {}", e))?;
        let length = u32::from_le_bytes(len_buf) as usize;

        // Read payload
        let mut payload = vec![0u8; length];
        stream
            .read_exact(&mut payload)
            .map_err(|e| format!("Engine read payload failed: {}", e))?;

        String::from_utf8(payload).map_err(|e| format!("Invalid UTF-8: {}", e))
    }

    /// Check if the engine is reachable.
    pub fn ping(&self) -> bool {
        self.send("ping").is_ok()
    }
}
