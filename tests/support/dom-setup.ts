/**
 * Runs before every test file, but only does anything in component tests.
 * jsdom has no modal dialog or matchMedia, so small stand-ins are added here.
 */
import { afterEach } from "vitest";

if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());

  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
