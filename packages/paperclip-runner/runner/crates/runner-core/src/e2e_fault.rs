//! E2E-only fault seams (TAX-452). This module exists only in builds with the
//! non-default `e2e-fault-injection` feature; the default and release
//! `paperclip-runnerd` contain none of it.
//!
//! A seam fires at most once per trigger file: the file is removed before the
//! fault so a restarted runnerd does not crash again.

use std::path::Path;

const TRIGGER_DIRECTORY: &str = "/tmp/paperclip-e2e-fault";

fn consume(trigger: &str) -> bool {
    std::fs::remove_file(Path::new(TRIGGER_DIRECTORY).join(trigger)).is_ok()
}

/// Called after runnerd has written a typed permission decision to the
/// OpenCode proxy and before the `request.resolve` command result is
/// journaled/acknowledged: the delivery outcome becomes indeterminate.
pub fn crash_after_permission_delivery(request_id: &str, decision: &str) {
    if consume("crash-after-permission-delivery") {
        let _ = std::fs::write(
            Path::new(TRIGGER_DIRECTORY).join("crashed-after-permission-delivery"),
            format!("{request_id} {decision}\n"),
        );
        eprintln!(
            "paperclip-runnerd: e2e fault: abort after delivering {decision} for {request_id}"
        );
        std::process::abort();
    }
}
