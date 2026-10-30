import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

import { videoTypeOf } from "../../../shared/video.ts";

export interface VideoDropOptions {
  /** Takes pasted or dropped videos; null when there is nowhere to send them. */
  readonly onFiles: ((files: ReadonlyArray<File>, at: number | null) => void) | null;
}

const videoFiles = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((file) => videoTypeOf(file) !== null);

/** Hands pasted and dropped video files to the page, which uploads them. */
export const VideoDrop = Extension.create<VideoDropOptions>({
  name: "videoDrop",

  addOptions: () => ({ onFiles: null }),

  addProseMirrorPlugins() {
    const { onFiles } = this.options;
    if (!onFiles) return [];
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            const files = videoFiles(event.clipboardData?.files);
            if (files.length === 0 || !view.editable) return false;
            onFiles(files, null);
            return true;
          },
          handleDrop: (view, event) => {
            const files = videoFiles(event.dataTransfer?.files);
            if (files.length === 0 || !view.editable) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            onFiles(files, at);
            return true;
          },
        },
      }),
    ];
  },
});
