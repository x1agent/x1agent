import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

interface Props {
  onSend: (text: string, requestId?: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [text, setText] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = text.trim();
    if (!v || disabled) return;
    onSend(v);
    setText("");
  }

  return (
    <form
      onSubmit={submit}
      className="flex gap-2 border-t border-zinc-900 bg-zinc-950 p-3"
    >
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        placeholder={placeholder ?? "Send a message to the agent…"}
        className="flex-1"
      />
      <Button type="submit" disabled={disabled || !text.trim()}>
        Send
      </Button>
    </form>
  );
}
