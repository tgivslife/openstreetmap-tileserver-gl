'use strict'

/**
 * Converts a TileServer zoom level to the zoom expected by MapLibre Native.
 *
 * Tiles: 256px tiles are one zoom below MapLibre Native's 512px tiles, so only a 512px tile renders at its own zoom.
 * Static maps: always one below, whatever their width. Overlays (paths, markers) are projected at the requested zoom
 * with 256px tiles, so a 512px-wide static map taking the tile exception rendered the map a zoom deeper than its overlay.
 * @param {number} zoom TileServer zoom level.
 * @param {number} logicalWidth Unscaled request width in pixels.
 * @param {'tile'|'static'} mode Rendering mode.
 * @returns {number} MapLibre Native zoom level.
 */
export function getMapLibreRenderZoom (zoom, logicalWidth, mode) {
  if (mode === 'static') {
    return Math.max(0, zoom - 1)
  }

  if (mode === 'tile') {
    return Math.max(0, logicalWidth === 512 ? zoom : zoom - 1)
  }

  throw new Error(`Unsupported render mode: ${mode}`)
}
