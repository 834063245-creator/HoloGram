// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// HoloGram v4 Phase 0 — TCP client to Rust analysis engine
// Connects to the engine's JSON-RPC server, sends requests, receives responses.
// Format: 4-byte LE length prefix + JSON payload (both directions).
// v4.1: Persistent connection with auto-reconnect for keep-alive support.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

/// Global persistent connection to the engine. One connection shared across all
/// EngineClient instances — saves TCP handshake overhead on every tool call.
static CONN: Mutex<Option<TcpStream>> = Mutex::new(None);

pub struct EngineClient {
    addr: String,
}

impl EngineClient {
    pub fn new(addr: &str) -> Self {
        Self { addr: addr.to_string() }
    }

    /// Send a raw text command and receive the JSON response.
    /// Uses a persistent keep-alive connection; reconnects transparently on failure.
    pub fn send(&self, command: &str) -> Result<String, String> {
        let mut guard = CONN.lock().map_err(|e| format!("Lock poisoned: {}", e))?;

        // Try existing connection first
        if let Some(ref mut stream) = *guard {
            if Self::send_on(stream, command).is_ok() {
                return Self::read_response(stream);
            }
            // Connection broken — reconnect below
            *guard = None;
        }

        // Fresh connection
        let addr: std::net::SocketAddr = self.addr.parse().map_err(|e| format!("Invalid addr: {}", e))?;
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
            .map_err(|e| format!("Engine connect failed: {}", e))?;
        stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
        stream.set_write_timeout(Some(Duration::from_secs(10))).ok();

        Self::send_on(&mut stream, command)?;
        let result = Self::read_response(&mut stream);

        // Cache for reuse
        *guard = Some(stream);
        result
    }

    fn send_on(stream: &mut TcpStream, command: &str) -> Result<(), String> {
        stream.write_all(command.as_bytes())
            .map_err(|e| format!("Engine write failed: {}", e))
    }

    fn read_response(stream: &mut TcpStream) -> Result<String, String> {
        // Read 4-byte length prefix
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf)
            .map_err(|e| format!("Engine read length failed: {}", e))?;
        let length = u32::from_le_bytes(len_buf) as usize;

        // Sanity check: prevent OOM on corrupted length
        if length > 100_000_000 {
            return Err(format!("Response too large: {} bytes", length));
        }

        // Read payload
        let mut payload = vec![0u8; length];
        stream.read_exact(&mut payload)
            .map_err(|e| format!("Engine read payload failed: {}", e))?;

        String::from_utf8(payload).map_err(|e| format!("Invalid UTF-8: {}", e))
    }

    /// Check if the engine is reachable.
    #[allow(dead_code)]
    pub fn ping(&self) -> bool {
        self.send("ping").is_ok()
    }
}
