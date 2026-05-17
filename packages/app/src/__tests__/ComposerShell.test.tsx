import { describe, it, expect, afterEach } from "bun:test";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ComposerShell } from "../features/sessions/ComposerShell";

afterEach(cleanup);

// Regression: the previous autosize implementation read `scrollHeight`
// inside a useEffect on every keystroke, forcing a full-document
// reflow that dominated iPad typing latency. The fix is a pure-CSS
// grid auto-grow trick where a hidden mirror <span> tracks the
// textarea's value (+ trailing space). These tests lock the structure
// so the JS reflow can't sneak back in.
describe("ComposerShell autosize", () => {
  it("renders a composer-autosize wrapper with the grid layout", () => {
    render(
      <ComposerShell value="hello" onChange={() => {}} onSubmit={() => {}} />,
    );
    const wrapper = screen.getByTestId("composer-autosize");
    expect(wrapper.classList.contains("grid")).toBe(true);
  });

  it("mirrors the textarea value into a hidden span so the grid row tracks it", () => {
    const value = "line one\nline two";
    render(
      <ComposerShell value={value} onChange={() => {}} onSubmit={() => {}} />,
    );
    const wrapper = screen.getByTestId("composer-autosize");
    // The mirror is the aria-hidden span; its text content must be the
    // textarea value + a trailing space (so a freshly typed newline
    // still extends the row).
    const mirror = wrapper.querySelector("span[aria-hidden]");
    expect(mirror).not.toBeNull();
    expect(mirror?.textContent).toBe(value + " ");
  });

  it("updates the mirror when value changes (no scrollHeight read needed)", () => {
    const { rerender } = render(
      <ComposerShell value="a" onChange={() => {}} onSubmit={() => {}} />,
    );
    let mirror = screen
      .getByTestId("composer-autosize")
      .querySelector("span[aria-hidden]");
    expect(mirror?.textContent).toBe("a ");
    rerender(
      <ComposerShell value="abc" onChange={() => {}} onSubmit={() => {}} />,
    );
    mirror = screen
      .getByTestId("composer-autosize")
      .querySelector("span[aria-hidden]");
    expect(mirror?.textContent).toBe("abc ");
  });

  it("typing fires onChange but does not depend on scrollHeight / layout", () => {
    const onChange = (v: string) => {
      received = v;
    };
    let received = "";
    render(
      <ComposerShell value="" onChange={onChange} onSubmit={() => {}} />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(received).toBe("hi");
  });
});
