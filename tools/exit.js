// Safety net for command-line runs: once the work is done, give Node a few seconds to exit on
// its own; if something is still holding it open (a stray browser or socket), exit anyway so a
// scheduled run can never hang. The timer is unref'd, so it never delays a normal exit.
export function exitWhenDone(graceMs = 10000) {
  setTimeout(() => {
    console.warn('Warning: the process did not exit on its own after finishing; exiting now.');
    process.exit(process.exitCode ?? 0);
  }, graceMs).unref();
}
