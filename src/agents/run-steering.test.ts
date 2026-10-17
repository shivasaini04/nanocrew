/**
 * stage45 item 5 — mid-run steering.
 *
 * The mailbox is small, but two of its properties are load-bearing and easy to get
 * wrong in a way nothing would notice:
 *
 *   - **draining is destructive.** A note the run has already been told about must not
 *     come back on the next turn, or the model reads it as a fresh instruction every
 *     time and never stops obeying it.
 *   - **it cannot grow without bound.** Notes are in memory for a run that may never
 *     drain them (it crashed, or it finished before the note landed).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addSteer,
  drainSteers,
  countSteers,
  _resetSteers,
  _setClock,
} from './run-steering.js';

beforeEach(() => _resetSteers());

describe('queueing', () => {
  it('holds a note for the cycle it was addressed to', () => {
    addSteer('cycle-a', 'try the search box');
    expect(countSteers('cycle-a')).toBe(1);
    expect(countSteers('cycle-b')).toBe(0);
  });

  it('keeps several notes in the order they were said', () => {
    addSteer('c', 'first');
    addSteer('c', 'second');
    expect(drainSteers('c').map((n) => n.text)).toEqual(['first', 'second']);
  });

  it('ignores an empty note rather than delivering a blank instruction', () => {
    expect(addSteer('c', '   ')).toBe(0);
    expect(countSteers('c')).toBe(0);
  });

  it('ignores a note with no cycle to deliver it to', () => {
    expect(addSteer('', 'hello')).toBe(0);
  });

  it('trims and caps the text — a very long note is a pasted document, not steering', () => {
    addSteer('c', '  spaced  ');
    expect(drainSteers('c')[0].text).toBe('spaced');
    addSteer('c', 'x'.repeat(5000));
    expect(drainSteers('c')[0].text.length).toBe(2000);
  });
});

describe('draining', () => {
  it('is destructive, so a note is acted on once and not obeyed forever', () => {
    addSteer('c', 'stop clicking that');
    expect(drainSteers('c').map((n) => n.text)).toEqual(['stop clicking that']);
    expect(drainSteers('c')).toEqual([]);
  });

  it('is empty for a run nobody has said anything to', () => {
    expect(drainSteers('quiet-cycle')).toEqual([]);
  });

  it('does not hand one run another run notes', () => {
    addSteer('a', 'for a');
    addSteer('b', 'for b');
    expect(drainSteers('a').map((n) => n.text)).toEqual(['for a']);
    expect(drainSteers('b').map((n) => n.text)).toEqual(['for b']);
  });
});

describe('bounds', () => {
  it('evicts the oldest when someone keeps typing', () => {
    for (let i = 0; i < 30; i++) addSteer('c', `note ${i}`);
    const notes = drainSteers('c');
    expect(notes.length).toBe(20);
    // The newest are the ones still describing what the human wants.
    expect(notes[notes.length - 1].text).toBe('note 29');
    expect(notes[0].text).toBe('note 10');
  });

  it('forgets notes a run never came back for', () => {
    // A run that crashed, or finished before its note landed, would otherwise leave
    // notes in the map for the life of the process.
    let t = 1_000_000;
    _setClock(() => t);

    addSteer('dead-cycle', 'anyone there?');
    expect(countSteers('dead-cycle')).toBe(1);

    t += 29 * 60 * 1000;
    expect(countSteers('dead-cycle')).toBe(1); // still inside the window

    t += 2 * 60 * 1000; // now past 30 minutes
    expect(countSteers('dead-cycle')).toBe(0);
    expect(drainSteers('dead-cycle')).toEqual([]);
  });

  it('a still-fresh note survives a sweep triggered by an expired one', () => {
    let t = 1_000_000;
    _setClock(() => t);
    addSteer('old-cycle', 'stale');
    t += 31 * 60 * 1000;
    addSteer('new-cycle', 'fresh');

    expect(countSteers('old-cycle')).toBe(0);
    expect(drainSteers('new-cycle').map((n) => n.text)).toEqual(['fresh']);
  });
});
