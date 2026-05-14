/**
 * Pure dispatcher for the `handle-latest-event` MCP tool.
 *
 * Extracted from `registerHandlers` (server/index.ts) so the routing logic can
 * be unit-tested without standing up an MCP server. The dispatcher only reads
 * its inputs — the interface trigger set, workflow definitions, and automated
 * slice map — through getter accessors, so each invocation observes the LIVE
 * state. This is load-bearing: resync mutates these structures in place
 * (clear + repopulate) and the stdio call site registers handlers BEFORE
 * `automatedSliceMap` and `_workflowDefs` are initialised in `main()`.
 */

import { parseSkillFrontmatter } from '@src/utils/skillUtils.js';
import { HANDLE_LATEST_EVENT_SKILL } from './systemSkills.js';

export interface HandleLatestEventDeps {
  /** Returns the current set of event types that trigger interface (manual) slices. */
  getTriggerEventSet: () => Set<string>;
  /** Returns the current workflow definitions map, or null if not yet loaded. */
  getWorkflowDefs: () => Map<string, any> | null;
  /** Returns the current map of event types to automated slice md paths. */
  getAutomatedSliceMap: () => Map<string, any>;
}

export interface DispatchResult {
  content: Array<{ type: 'text'; text: string }>;
}

export function dispatchLatestEvent(evt: any, deps: HandleLatestEventDeps): DispatchResult {
  const type: string | undefined = evt?.type;

  if (!type) {
    const { description, body } = parseSkillFrontmatter(HANDLE_LATEST_EVENT_SKILL);
    return {
      content: [{ type: 'text', text: `Skill/Slice: handle-latest-event\nDescription: ${description}\n\n${body}` }],
    };
  }

  if (type === 'workflow_completed') {
    return {
      content: [{ type: 'text', text:
        `The workflow has completed cleanly. Summarise the run for the user from the progress events you have already seen, then stop polling — do NOT call get-next-event again for this session.`
      }],
    };
  }

  if (type === 'unexpected_last_event') {
    const origType = evt?.payload?.originalEvent?.type ?? '<unknown>';
    return {
      content: [{ type: 'text', text:
        `No skill is registered for event type \`${origType}\`. The workflow has a wiring gap — inform the user of the unmatched event type and stop polling.`
      }],
    };
  }

  // Interface event: locate the slice whose `given[]` lists this event.
  // The slice is exposed as its own MCP tool via buildToolDefs; the agent
  // invokes that tool directly (or via complete-slice once facts are gathered).
  if (deps.getTriggerEventSet().has(type)) {
    let matchedSlice: { workflow: string; slice: string } | null = null;
    for (const wf of deps.getWorkflowDefs()?.values() ?? []) {
      for (const s of wf.slices) {
        if (!s.isInterface) continue;
        if (s.givenEventGroups.some((g: string[]) => g.includes(type))) {
          matchedSlice = { workflow: wf.name, slice: s.name };
          break;
        }
      }
      if (matchedSlice) break;
    }
    if (matchedSlice) {
      return {
        content: [{ type: 'text', text:
          `Interface event \`${type}\`. Invoke the slice tool for "${matchedSlice.slice}" (workflow "${matchedSlice.workflow}") to gather any required facts, then call complete-slice with sliceId="${matchedSlice.slice}" and the collected facts. After completion, call get-next-event to continue.`
        }],
      };
    }
    return {
      content: [{ type: 'text', text:
        `Interface event \`${type}\` is registered but no matching slice was found in any workflow definition. Inform the user and stop polling.`
      }],
    };
  }

  // Automation event: server already evaluated and published the outcome.
  // Agent's only job is to keep the loop moving.
  if (deps.getAutomatedSliceMap().has(type)) {
    return {
      content: [{ type: 'text', text:
        `Automation event \`${type}\`. The server has already evaluated this slice and published its outcome. Acknowledge the step briefly to the user, then immediately call get-next-event to continue.`
      }],
    };
  }

  // Should be unreachable — the event-router wraps unhandled events as
  // workflow_completed or unexpected_last_event before delivering.
  return {
    content: [{ type: 'text', text:
      `Event \`${type}\` has no registered handler in any workflow. Inform the user and stop polling.`
    }],
  };
}
