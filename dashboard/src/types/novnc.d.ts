/**
 * noVNC ships no type declarations, so this describes the part of it we actually use
 * (stage 50 phase 4).
 *
 * Deliberately not `any`: the whole value of a declaration here is that a typo in a
 * property name is a compile error rather than a setting that silently does nothing.
 * `scaleViewport` in particular — misspell it and the 1920x1080 screen renders at full
 * size inside a drawer a third that wide, with no error anywhere.
 *
 * Only what is used is declared. RFB has a much larger surface; adding to it as we need
 * it keeps this honest about what we depend on.
 */
declare module '@novnc/novnc/lib/rfb' {
    interface RFBOptions {
        /** Let other viewers stay connected. We pass false: RFB is a 1:1 conversation. */
        shared?: boolean;
        credentials?: { username?: string; password?: string; target?: string };
        repeaterID?: string;
        wsProtocols?: string[];
    }

    export default class RFB extends EventTarget {
        constructor(target: HTMLElement, url: string, options?: RFBOptions);

        /** Send no input. What separates watching from driving. */
        viewOnly: boolean;
        /** Scale the remote screen to fit the element, rather than cropping it. */
        scaleViewport: boolean;
        /** Ask the server to change the real screen size. We never do — see VncViewer. */
        resizeSession: boolean;
        background: string;
        qualityLevel: number;
        compressionLevel: number;

        disconnect(): void;
        focus(): void;
        blur(): void;
    }
}
