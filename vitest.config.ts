import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // dashboard/src/lib holds React-free logic (the conversation-event fold) that is
    // worth testing on its own; the dashboard has no test runner of its own, and the
    // module imports nothing at runtime, so it runs fine under this project's vitest.
    //
    // dashboard/src/stores added 2026-09-02: a zustand store is React-free in the same
    // way and holds real logic worth pinning (liveBrowsersStore infers whether a browser
    // is open from the gaps between frames). Without this line a test file written there
    // is collected by nothing and passes by never running — which this repo has been
    // bitten by before.
    // companion/ added 2026-09-06 (stage 52 step 2): the companion is a second browser
    // controller alongside the extension, and its test drives the real broker, the real
    // upgrade handler and a real Chrome. Same reasoning as the lines above — without this
    // the file would be collected by nothing and pass by never running.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'skills-engine/**/*.test.ts',
      'dashboard/src/lib/**/*.test.ts',
      'dashboard/src/stores/**/*.test.ts',
      'companion/**/*.test.ts',
      // stage 60: the desktop app's permission rules (local-policy.js) are Electron-free
      // on purpose, so they can be tested here rather than never.
      'desktop/*.test.ts',
    ],
  },
});
