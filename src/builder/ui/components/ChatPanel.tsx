/**
 * Chat, agent activity, and the composer.
 *
 * Tool calls render inline with the assistant message that made them, because the useful
 * mental model is "the agent did these things while writing this", not two parallel logs.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronRight,
  CircleSlash,
  Loader2,
  Square,
  X,
} from 'lucide-react';

import type { AgentStatus, ChatMessage, ToolEventSummary } from '../../core/types';
import { Markdown } from './Markdown';

function ToolRow({ event }: { event: ToolEventSummary }) {
  const [open, setOpen] = useState(false);
  const duration = event.endedAt ? `${Math.round((event.endedAt - event.startedAt) / 100) / 10}s` : null;

  const icon =
    event.status === 'running' ? (
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-400" />
    ) : event.status === 'ok' ? (
      <Check className="h-3 w-3 shrink-0 text-emerald-500" />
    ) : event.status === 'denied' ? (
      <CircleSlash className="h-3 w-3 shrink-0 text-neutral-500" />
    ) : (
      <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
    );

  const expandable = Boolean(event.paths?.length || event.detail);

  return (
    <div className="rounded-md border border-neutral-800/80 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${
          expandable ? 'cursor-pointer hover:bg-neutral-800/40' : 'cursor-default'
        }`}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-neutral-300">{event.title}</span>
        {event.detail && !open && (
          <span className="shrink-0 text-[11px] text-neutral-500">{event.detail}</span>
        )}
        {duration && <span className="shrink-0 tabular-nums text-[11px] text-neutral-600">{duration}</span>}
        {expandable && (
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        )}
      </button>
      {open && (
        <div className="space-y-1 border-t border-neutral-800/80 px-2.5 py-2 text-[11.5px] text-neutral-400">
          {event.detail && <p>{event.detail}</p>}
          {event.paths?.map((p) => (
            <div key={p} className="font-mono text-[11px] text-neutral-500">
              {p}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-neutral-100 px-3.5 py-2 text-[13.5px] leading-relaxed text-neutral-900">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {message.toolEvents && message.toolEvents.length > 0 && (
        <div className="space-y-1">
          {message.toolEvents.map((event) => (
            <ToolRow key={event.id} event={event} />
          ))}
        </div>
      )}
      {message.content && <Markdown source={message.content} />}
      {message.error && (
        <div className="flex items-start gap-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{message.error}</span>
        </div>
      )}
      {message.interrupted && <p className="text-xs italic text-neutral-600">Stopped.</p>}
    </div>
  );
}

function TaskList({ status }: { status: AgentStatus }) {
  if (!status.tasks.length) return null;
  return (
    <div className="space-y-1 rounded-lg border border-neutral-800 bg-neutral-900/50 p-2.5">
      {status.tasks.map((task) => (
        <div key={task.id} className="flex items-center gap-2 text-xs">
          {task.status === 'done' ? (
            <Check className="h-3 w-3 shrink-0 text-emerald-500" />
          ) : task.status === 'active' ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-400" />
          ) : task.status === 'failed' ? (
            <X className="h-3 w-3 shrink-0 text-red-500" />
          ) : (
            <div className="h-3 w-3 shrink-0 rounded-full border border-neutral-700" />
          )}
          <span className={task.status === 'done' ? 'text-neutral-600 line-through' : 'text-neutral-300'}>
            {task.title}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface ChatPanelProps {
  messages: ChatMessage[];
  streamingText: string;
  streamingToolEvents: ToolEventSummary[];
  status: AgentStatus;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onSend: (prompt: string) => void;
  onCancel: () => void;
}

export function ChatPanel(props: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);

  // Follow the stream, but stop following the moment the user scrolls up to read
  // something — yanking them back to the bottom mid-read is worse than not following.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [props.messages, props.streamingText, props.streamingToolEvents]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = () => {
    const value = draft.trim();
    if (!value || props.busy || props.disabled) return;
    props.onSend(value);
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const isEmpty = props.messages.length === 0 && !props.streamingText;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {isEmpty && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-neutral-400">Describe what you want to build.</p>
            <p className="max-w-xs text-xs leading-relaxed text-neutral-600">
              The agent edits files, runs the dev server, and tests the result in a real browser
              before telling you it is done.
            </p>
          </div>
        )}

        {props.messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {(props.streamingText || props.streamingToolEvents.length > 0) && (
          <div className="space-y-2">
            {props.streamingToolEvents.length > 0 && (
              <div className="space-y-1">
                {props.streamingToolEvents.map((event) => (
                  <ToolRow key={event.id} event={event} />
                ))}
              </div>
            )}
            {props.streamingText && <Markdown source={props.streamingText} />}
          </div>
        )}

        {props.busy && <TaskList status={props.status} />}

        {props.busy && props.status.phase !== 'idle' && (
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>
              {props.status.message ??
                (props.status.phase === 'thinking'
                  ? 'Thinking'
                  : props.status.phase === 'verifying'
                    ? 'Verifying'
                    : 'Working')}
            </span>
            {props.status.step > 0 && (
              <span className="tabular-nums text-neutral-700">
                step {props.status.step}/{props.status.maxSteps}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-3">
        {props.disabled && props.disabledReason && (
          <p className="mb-2 text-xs text-amber-500">{props.disabledReason}</p>
        )}
        <div className="relative rounded-xl border border-neutral-800 bg-neutral-900 focus-within:border-neutral-700">
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={props.disabled}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline. Matches every chat UI people
              // already have muscle memory for.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={props.disabled ? 'Unavailable' : 'Describe a change, or ask a question'}
            className="max-h-[200px] w-full resize-none bg-transparent px-3.5 py-3 pr-12 text-[13.5px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={props.busy ? props.onCancel : submit}
            disabled={props.disabled || (!props.busy && !draft.trim())}
            aria-label={props.busy ? 'Stop' : 'Send'}
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-100 text-neutral-900 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-25"
          >
            {props.busy ? <Square className="h-3 w-3 fill-current" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
