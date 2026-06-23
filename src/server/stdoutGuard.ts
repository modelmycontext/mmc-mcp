// STDOUT GUARD — import this FIRST, before any module that may transitively log.
//
// StdioServerTransport owns process.stdout for newline-delimited JSON-RPC
// framing. Any stray write to fd 1 corrupts the protocol stream (and is a
// message-injection vector — see SECURITY.md). Aliasing the console writers to
// stderr catches third-party deps that bypass the logger. `console.error` is
// unaffected, so deliberate error logging still works.
//
// This module has NO imports on purpose: when it is the first import of the
// entry module, ESM evaluates it before every other import, so the guard is in
// place before any other module's top-level code can run.
if (!process.env.VITE) {
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.warn = console.error.bind(console);
  console.debug = console.error.bind(console);
}

export {};
