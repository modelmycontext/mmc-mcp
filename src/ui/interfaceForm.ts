// interfaceForm.ts — the ui:// resource served to MCP Apps hosts and the _meta
// constants used to link interface slice tools to it.
//
// The renderer HTML lives in the sibling interface-form.html (a real, editable
// file) and is read lazily via import.meta.url so it resolves both under Bun
// (which runs the TS source directly) and under Node/vitest. Cached after first
// read; falls back to a stub if the file can't be located (e.g. a bundled dist
// that didn't copy the asset).
import fs from 'fs';
import { logger } from '@src/utils/logger.js';

/** Canonical URI of the interface-form UI resource. */
export const INTERFACE_FORM_URI = 'ui://mmc/interface-form';

/** _meta namespace key linking a tool / result to its UI resource. Tracks the
 *  MCP Apps ("Claude apps") extension — the field is `_meta.ui.resourceUri`. */
export const UI_META_KEY = 'ui';

/** Namespaced key under which the FormSpec data travels on a tool result. */
export const FORM_SPEC_META_KEY = 'mmc/formSpec';

/** The renderer HTML for ui://mmc/interface-form. Read on each request (the
 *  file is ~13KB and a form loads at most once per interface step, so the I/O
 *  is negligible) — this also means edits to interface-form.html are picked up
 *  live in dev without restarting the server. */
export function getInterfaceFormHtml(): string {
  try {
    return fs.readFileSync(new URL('./interface-form.html', import.meta.url), 'utf8');
  } catch (err: any) {
    logger.warn({ error: err?.message }, '[ui] interface-form.html not found — serving stub');
    return '<!doctype html><meta charset="utf-8"><body>Interface form renderer unavailable.</body>';
  }
}
