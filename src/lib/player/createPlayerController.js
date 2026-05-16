// src/lib/player/createPlayerController.js
/**
 * Polymorphic player-controller factory (spec §2.2).
 *
 * The WebSocket sync layer (useVideoSync) interacts ONLY with the object this
 * factory returns. It must never branch on player type — that is the entire
 * point of the abstraction. Both backends expose an identical surface and a
 * single normalized state enum (PLAYER_STATE).
 */
'use client';

import { SOURCE_KIND } from '@/features/rooms/room-types';
import { createYouTubeController } from './youtubeController';
import { createHtml5Controller } from './html5Controller';

/**
 * The contract every controller satisfies.
 * @typedef {Object} PlayerController
 * @property {'youtube'|'html5'} kind
 * @property {() => void}            play
 * @property {() => void}            pause
 * @property {(seconds:number)=>void} seekTo
 * @property {() => number}          getCurrentTime
 * @property {() => number}          getDuration
 * @property {() => string}          getState        normalized PLAYER_STATE
 * @property {() => boolean}         isReady
 * @property {() => void}            destroy         full teardown
 */

/**
 * Build a controller for the given source.
 * @param {Object} opts
 * @param {HTMLElement} opts.container DOM node the player mounts into.
 * @param {import('@/features/rooms/room-types').VideoSource} opts.source
 * @param {(s:{state:string})=>void} opts.onStateChange Normalized state changes.
 * @param {()=>void} [opts.onReady]
 * @param {(e:any)=>void} [opts.onError]
 * @returns {PlayerController}
 */
export function createPlayerController({ container, source, onStateChange, onReady, onError }) {
  if (!container) throw new Error('createPlayerController: container is required');
  if (!source || !source.kind) throw new Error('createPlayerController: source.kind is required');

  switch (source.kind) {
    case SOURCE_KIND.YOUTUBE:
      return createYouTubeController({ container, source, onStateChange, onReady, onError });
    case SOURCE_KIND.HTML5:
      return createHtml5Controller({ container, source, onStateChange, onReady, onError });
    default:
      throw new Error(`createPlayerController: unknown source kind "${source.kind}"`);
  }
}
