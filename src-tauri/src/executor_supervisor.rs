use super::*;
use std::io::Read;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

const EXECUTOR_PROTOCOL: &str = "coven.executor-local.v1";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_secs(40);
const TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(2);
const SERVE_ARGS: [&str; 3] = ["executor", "local", "serve"];
const STOP_ARGS: [&str; 3] = ["executor", "local", "stop"];
const STATUS_ARGS: [&str; 4] = ["executor", "local", "status", "--json"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ExecutorDisplayState {
    Unavailable,
    Starting,
    Stopping,
    Draining,
    Running(String),
    External { owner: String, runtime: String },
    Paused,
    Stopped,
    Error,
}

impl ExecutorDisplayState {
    pub(super) fn label(&self) -> String {
        match self {
            Self::Unavailable => "Executor: unavailable".to_string(),
            Self::Starting => "Executor: starting".to_string(),
            Self::Stopping => "Executor: stopping".to_string(),
            Self::Draining => "Executor: draining; Cave remains open".to_string(),
            Self::Running(runtime) => format!("Executor: {runtime}"),
            Self::External { owner, runtime } => format!("Executor: {owner} — {runtime}"),
            Self::Paused => "Executor: paused".to_string(),
            Self::Stopped => "Executor: stopped".to_string(),
            Self::Error => "Executor: status unavailable".to_string(),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExecutorStatus {
    protocol_version: String,
    desired_state: String,
    runtime_state: String,
    owner: String,
}

fn parse_executor_status(raw: &[u8]) -> ExecutorDisplayState {
    // All rendered values come from the required v1 fields and their strict
    // allowlists. Unknown fields are deliberately ignored: status may grow
    // private diagnostics, and rejecting them is neither redaction nor
    // forward compatibility. They never enter ExecutorDisplayState.
    let Ok(status) = serde_json::from_slice::<RawExecutorStatus>(raw) else {
        return ExecutorDisplayState::Error;
    };
    if status.protocol_version != EXECUTOR_PROTOCOL
        || !matches!(status.owner.as_str(), "legacy" | "desktop" | "headless")
        || !matches!(
            status.desired_state.as_str(),
            "running" | "paused" | "stopped"
        )
        || !matches!(
            status.runtime_state.as_str(),
            "starting"
                | "idle"
                | "claiming"
                | "executing"
                | "paused"
                | "stopping"
                | "stopped"
                | "stale"
        )
    {
        return ExecutorDisplayState::Error;
    }

    if matches!(status.owner.as_str(), "headless" | "legacy") {
        return ExecutorDisplayState::External {
            owner: status.owner,
            runtime: status.runtime_state,
        };
    }

    if status.desired_state == "stopped"
        && !matches!(status.runtime_state.as_str(), "stopped" | "stale")
    {
        return ExecutorDisplayState::Draining;
    }

    match status.runtime_state.as_str() {
        "starting" => ExecutorDisplayState::Starting,
        "stopping" => ExecutorDisplayState::Draining,
        "paused" => ExecutorDisplayState::Paused,
        "stopped" => ExecutorDisplayState::Stopped,
        runtime => ExecutorDisplayState::Running(runtime.to_string()),
    }
}

pub(super) struct ExecutorProcess {
    child: Child,
    #[cfg(target_os = "windows")]
    job: windows_process_job::ProcessJob,
}

#[derive(Clone)]
pub(super) struct ExecutorTrayControls {
    pub(super) status: MenuItem<tauri::Wry>,
    pub(super) start: MenuItem<tauri::Wry>,
    pub(super) stop: MenuItem<tauri::Wry>,
}

impl ExecutorTrayControls {
    pub(super) fn apply(
        &self,
        status: &ExecutorDisplayState,
        owns_live_child: bool,
    ) -> Result<(), String> {
        self.status
            .set_text(status.label())
            .map_err(|error| format!("could not update executor status menu: {error}"))?;
        let (start_enabled, stop_enabled) = executor_menu_policy(status, owns_live_child);
        self.start
            .set_enabled(start_enabled)
            .map_err(|error| format!("could not update executor start menu: {error}"))?;
        self.stop
            .set_enabled(stop_enabled)
            .map_err(|error| format!("could not update executor stop menu: {error}"))?;
        Ok(())
    }
}

fn executor_menu_policy(status: &ExecutorDisplayState, owns_live_child: bool) -> (bool, bool) {
    if matches!(status, ExecutorDisplayState::External { .. }) {
        return (false, false);
    }
    if matches!(
        status,
        ExecutorDisplayState::Starting | ExecutorDisplayState::Stopping
    ) {
        return (false, false);
    }
    (
        !owns_live_child && matches!(status, ExecutorDisplayState::Stopped),
        owns_live_child,
    )
}

impl ExecutorProcess {
    fn has_exited(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|error| format!("could not inspect owned executor: {error}"))
    }
}

pub(super) struct ExecutorSupervisor {
    process: Mutex<Option<ExecutorProcess>>,
    monitor_started: AtomicBool,
    shutdown_requested: AtomicBool,
    exit_in_progress: AtomicBool,
}

impl Default for ExecutorSupervisor {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            monitor_started: AtomicBool::new(false),
            shutdown_requested: AtomicBool::new(false),
            exit_in_progress: AtomicBool::new(false),
        }
    }
}

pub(super) struct ExecutorCleanupGuard(pub(super) Arc<ExecutorSupervisor>);

impl tauri::Resource for ExecutorCleanupGuard {}

impl Drop for ExecutorCleanupGuard {
    fn drop(&mut self) {
        self.0.shutdown_requested.store(true, Ordering::Release);
        if self.0.owns_live_child() {
            log::error!(
                "[cave] application cleanup reached a live executor; refusing normal-path termination"
            );
        }
    }
}

pub(super) fn refresh_executor_tray_once(
    app: &tauri::AppHandle,
    supervisor: &Arc<ExecutorSupervisor>,
    controls: &ExecutorTrayControls,
) {
    let status = query_executor_status();
    if supervisor.shutdown_requested.load(Ordering::Acquire) {
        return;
    }
    let owns = supervisor.owns_live_child();
    let controls = controls.clone();
    let supervisor = Arc::clone(supervisor);
    if let Err(error) = app.run_on_main_thread(move || {
        if supervisor.shutdown_requested.load(Ordering::Acquire) {
            return;
        }
        if let Err(error) = controls.apply(&status, owns) {
            log::warn!("[cave] {error}");
        }
    }) {
        log::warn!("[cave] could not schedule executor tray refresh: {error}");
    }
}

impl ExecutorSupervisor {
    pub(super) fn start_tray_monitor(
        self: &Arc<Self>,
        app: tauri::AppHandle,
        controls: ExecutorTrayControls,
    ) {
        if self
            .monitor_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        self.shutdown_requested.store(false, Ordering::Release);
        let supervisor = Arc::clone(self);
        thread::spawn(move || {
            while !supervisor.shutdown_requested.load(Ordering::Acquire) {
                refresh_executor_tray_once(&app, &supervisor, &controls);
                let deadline = Instant::now() + TRAY_REFRESH_INTERVAL;
                while Instant::now() < deadline {
                    if supervisor.shutdown_requested.load(Ordering::Acquire) {
                        supervisor.monitor_started.store(false, Ordering::Release);
                        return;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
            supervisor.monitor_started.store(false, Ordering::Release);
        });
    }

    fn reap_exited_locked(process: &mut Option<ExecutorProcess>) -> Result<(), String> {
        let exited = match process.as_mut() {
            Some(owned) => owned.has_exited()?,
            None => false,
        };
        if exited {
            if let Some(mut exited) = process.take() {
                exited
                    .child
                    .wait()
                    .map_err(|error| format!("could not reap exited executor: {error}"))?;
            }
        }
        Ok(())
    }

    pub(super) fn start(&self) -> Result<(), String> {
        if self.exit_in_progress.load(Ordering::Acquire) {
            return Err("Cave is waiting for executor shutdown".to_string());
        }
        let mut process = self
            .process
            .lock()
            .map_err(|_| "executor supervisor lock is poisoned".to_string())?;
        Self::reap_exited_locked(&mut process)?;
        if process.is_some() {
            return Err("Cave already owns a running executor".to_string());
        }
        let coven = find_coven().ok_or_else(|| "Coven CLI is not installed".to_string())?;

        #[cfg(target_os = "windows")]
        let (mut command, job, gate) = {
            let job = windows_process_job::ProcessJob::new()
                .map_err(|error| format!("could not create executor process job: {error}"))?;
            let gate = windows_process_job::ProcessLaunchGate::new()
                .map_err(|error| format!("could not create executor launch gate: {error}"))?;
            let launcher = gate
                .launcher(&coven, SERVE_ARGS)
                .map_err(|error| format!("could not prepare executor launch: {error}"))?;
            (launcher.into_std_command(), job, gate)
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new(&coven);
            command.args(SERVE_ARGS);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        command.creation_flags(0x08000000);
        let child = command
            .spawn()
            .map_err(|error| format!("could not start executor: {error}"))?;

        #[cfg(target_os = "windows")]
        let owned = {
            if let Err(error) = job.assign_child(&child) {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("could not own executor process: {error}"));
            }
            if let Err(error) = gate.release() {
                let _ = job.terminate();
                return Err(format!("could not release executor process: {error}"));
            }
            ExecutorProcess { child, job }
        };
        #[cfg(not(target_os = "windows"))]
        let owned = ExecutorProcess { child };
        *process = Some(owned);
        Ok(())
    }

    pub(super) fn stop(&self) -> Result<ExecutorStopOutcome, String> {
        {
            let mut process = self
                .process
                .lock()
                .map_err(|_| "executor supervisor lock is poisoned".to_string())?;
            Self::reap_exited_locked(&mut process)?;
            if process.is_none() {
                return Ok(ExecutorStopOutcome::Stopped);
            }
        }

        let deadline = Instant::now() + EXIT_DRAIN_TIMEOUT;
        let _cooperative_stop_started = find_coven().is_some_and(|coven| {
            let mut stop = Command::new(coven);
            stop.args(STOP_ARGS)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            stop.creation_flags(0x08000000);
            if let Ok(mut command) = stop.spawn() {
                let _ = wait_for_child(&mut command, STOP_COMMAND_TIMEOUT);
                true
            } else {
                false
            }
        });
        let mut process = self
            .process
            .lock()
            .map_err(|_| "executor supervisor lock is poisoned".to_string())?;
        Self::reap_exited_locked(&mut process)?;
        drop(process);

        while Instant::now() < deadline {
            if !self.owns_live_child() {
                return Ok(ExecutorStopOutcome::Stopped);
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(ExecutorStopOutcome::Draining)
    }

    fn begin_exit(&self) -> bool {
        self.exit_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    fn decline_exit(&self) {
        self.exit_in_progress.store(false, Ordering::Release);
    }

    fn prepare_for_exit(&self) -> bool {
        if self.owns_live_child() {
            return false;
        }
        self.shutdown_requested.store(true, Ordering::Release);
        true
    }

    pub(super) fn owns_live_child(&self) -> bool {
        let Ok(mut process) = self.process.lock() else {
            return false;
        };
        let _ = Self::reap_exited_locked(&mut process);
        process.is_some()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ExecutorStopOutcome {
    Stopped,
    Draining,
}

fn exit_allowed_after_stop(outcome: ExecutorStopOutcome, owns_live_child: bool) -> bool {
    outcome == ExecutorStopOutcome::Stopped && !owns_live_child
}

pub(super) fn apply_executor_tray_state(
    app: &tauri::AppHandle,
    controls: ExecutorTrayControls,
    state: ExecutorDisplayState,
    owns_live_child: bool,
) {
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = controls.apply(&state, owns_live_child) {
            log::warn!("[cave] {error}");
        }
    });
}

pub(super) fn request_cooperative_app_exit(app: &tauri::AppHandle) {
    let Some(supervisor) = app.try_state::<Arc<ExecutorSupervisor>>() else {
        app.exit(0);
        return;
    };
    let supervisor = Arc::clone(supervisor.inner());
    if !supervisor.begin_exit() {
        return;
    }
    let controls = app
        .try_state::<ExecutorTrayControls>()
        .map(|state| state.inner().clone());
    let app = app.clone();
    if let Some(controls) = controls.as_ref() {
        apply_executor_tray_state(&app, controls.clone(), ExecutorDisplayState::Stopping, true);
    }
    thread::spawn(move || match supervisor.stop() {
        Ok(outcome)
            if exit_allowed_after_stop(outcome, supervisor.owns_live_child())
                && supervisor.prepare_for_exit() =>
        {
            #[cfg(target_os = "windows")]
            shutdown_owned_processes(&app);
            app.exit(0);
        }
        Ok(ExecutorStopOutcome::Draining) | Ok(ExecutorStopOutcome::Stopped) => {
            supervisor.decline_exit();
            if let Some(controls) = controls {
                apply_executor_tray_state(&app, controls, ExecutorDisplayState::Draining, true);
            }
            focus_main_window(&app);
        }
        Err(error) => {
            log::warn!("[cave] cooperative executor shutdown failed: {error}");
            supervisor.decline_exit();
            if let Some(controls) = controls {
                apply_executor_tray_state(&app, controls, ExecutorDisplayState::Error, true);
            }
            focus_main_window(&app);
        }
    });
}

fn wait_for_child(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

pub(super) fn query_executor_status() -> ExecutorDisplayState {
    let Some(coven) = find_coven() else {
        return ExecutorDisplayState::Unavailable;
    };
    let mut command = Command::new(coven);
    command.args(STATUS_ARGS);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let Ok(mut child) = command.stderr(Stdio::null()).stdout(Stdio::piped()).spawn() else {
        return ExecutorDisplayState::Error;
    };
    let Some(status) = wait_for_child(&mut child, COMMAND_TIMEOUT) else {
        return ExecutorDisplayState::Error;
    };
    if !status.success() {
        return ExecutorDisplayState::Error;
    }
    let Some(stdout) = child.stdout.take() else {
        return ExecutorDisplayState::Error;
    };
    let mut output = Vec::new();
    if stdout.take(64 * 1024 + 1).read_to_end(&mut output).is_err() || output.len() > 64 * 1024 {
        return ExecutorDisplayState::Error;
    }
    parse_executor_status(&output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_parser_only_reveals_allowlisted_values() {
        let state = parse_executor_status(
            br#"{"protocolVersion":"coven.executor-local.v1","desiredState":"running","runtimeState":"executing","owner":"desktop","token":"must-not-leak"}"#,
        );
        assert_eq!(
            state,
            ExecutorDisplayState::Running("executing".to_string())
        );
        assert_eq!(state.label(), "Executor: executing");
    }

    #[test]
    fn status_parser_fails_closed_on_unknown_protocol_or_state() {
        assert_eq!(
            parse_executor_status(br#"{"protocolVersion":"future","desiredState":"running","runtimeState":"executing","owner":"desktop"}"#),
            ExecutorDisplayState::Error
        );
        assert_eq!(
            parse_executor_status(br#"{"protocolVersion":"coven.executor-local.v1","desiredState":"running","runtimeState":"secret-state","owner":"desktop"}"#),
            ExecutorDisplayState::Error
        );
        assert_eq!(
            parse_executor_status(br#"{"protocolVersion":"coven.executor-local.v1","desiredState":"paused","runtimeState":"pausing","owner":"desktop"}"#),
            ExecutorDisplayState::Error
        );
        assert_eq!(
            parse_executor_status(br#"{"protocolVersion":"coven.executor-local.v1","desiredState":"stopped","runtimeState":"executing","owner":"desktop"}"#),
            ExecutorDisplayState::Draining
        );
    }

    #[test]
    fn tray_actions_fail_closed_and_stop_only_an_owned_child() {
        assert_eq!(
            executor_menu_policy(&ExecutorDisplayState::Error, false),
            (false, false)
        );
        assert_eq!(
            executor_menu_policy(&ExecutorDisplayState::Running("idle".into()), false),
            (false, false)
        );
        assert_eq!(
            executor_menu_policy(
                &ExecutorDisplayState::External {
                    owner: "headless".into(),
                    runtime: "stopped".into(),
                },
                false,
            ),
            (false, false)
        );
        assert_eq!(
            executor_menu_policy(&ExecutorDisplayState::Stopped, false),
            (true, false)
        );
        assert_eq!(
            executor_menu_policy(&ExecutorDisplayState::Error, true),
            (false, true)
        );
        assert_eq!(
            executor_menu_policy(&ExecutorDisplayState::Stopping, true),
            (false, false)
        );
    }

    #[test]
    fn cli_contract_uses_executor_local_v1_commands() {
        assert_eq!(SERVE_ARGS, ["executor", "local", "serve"]);
        assert_eq!(STOP_ARGS, ["executor", "local", "stop"]);
        assert_eq!(STATUS_ARGS, ["executor", "local", "status", "--json"]);
        assert!(
            STOP_COMMAND_TIMEOUT > Duration::from_secs(25),
            "cooperative stop must outlive the executor's bounded claim poll"
        );
    }

    #[test]
    fn exit_policy_declines_while_an_owned_worker_is_draining() {
        assert!(exit_allowed_after_stop(ExecutorStopOutcome::Stopped, false));
        assert!(!exit_allowed_after_stop(
            ExecutorStopOutcome::Draining,
            true
        ));
        assert!(!exit_allowed_after_stop(ExecutorStopOutcome::Stopped, true));

        let supervisor = ExecutorSupervisor::default();
        supervisor.exit_in_progress.store(true, Ordering::Release);
        assert_eq!(
            supervisor
                .start()
                .expect_err("exit gate blocks a new child"),
            "Cave is waiting for executor shutdown"
        );
    }

    #[test]
    fn non_desktop_owners_are_redacted_and_never_become_desktop_actions() {
        let headless = parse_executor_status(
            br#"{"protocolVersion":"coven.executor-local.v1","desiredState":"stopped","runtimeState":"stopped","owner":"headless","credential":"hidden"}"#,
        );
        assert_eq!(
            headless,
            ExecutorDisplayState::External {
                owner: "headless".into(),
                runtime: "stopped".into(),
            }
        );
        assert_eq!(headless.label(), "Executor: headless — stopped");
        assert_eq!(executor_menu_policy(&headless, false), (false, false));
        assert_eq!(executor_menu_policy(&headless, true), (false, false));

        let legacy = parse_executor_status(
            br#"{"protocolVersion":"coven.executor-local.v1","desiredState":"running","runtimeState":"executing","owner":"legacy"}"#,
        );
        assert_eq!(legacy.label(), "Executor: legacy — executing");
        assert_eq!(executor_menu_policy(&legacy, false), (false, false));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn cleanup_guard_does_not_kill_a_live_executor() {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn executor cleanup fixture");
        let supervisor = Arc::new(ExecutorSupervisor::default());
        *supervisor.process.lock().expect("executor slot") = Some(ExecutorProcess { child });

        drop(ExecutorCleanupGuard(Arc::clone(&supervisor)));
        assert!(supervisor.owns_live_child());

        let mut owned = supervisor
            .process
            .lock()
            .expect("executor slot")
            .take()
            .expect("owned fixture");
        owned.child.kill().expect("stop test fixture");
        owned.child.wait().expect("reap test fixture");
    }
}
