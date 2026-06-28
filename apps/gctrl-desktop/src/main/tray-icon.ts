// Menu-bar tray icon — a coffee-cup glyph (the Caffeine-replacement nod).
//
// The PNGs are embedded as base64 so the asset ships inside the JS bundle.
// That sidesteps electron-builder asar packing and `extraResources` path
// juggling across dev (`out/main`) and packaged (`process.resourcesPath`)
// layouts — `nativeImage.createFromBuffer` needs no file on disk.
//
// These are *template* images: pure black + alpha. macOS automatically
// recolors a template image white-on-dark / black-on-light to match the menu
// bar, so a single asset works in both appearances.

import { nativeImage, type NativeImage } from "electron"

// 16×16 (@1x) and 32×32 (@2x) coffee-cup template PNGs.
const ICON_1X =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABFElEQVR4nI3SzSqGURAH8N/DmxJK1j4WysYlWNqIlZAboChrKzfgGtwBZaes3YYVe6J85uPVaB6dXs/78a/pzJk55z//mXNoxnDhj+iBoQZ/FUe5P8QGqg7SngRLmMI3VvCKtgFQJck4TrGFWVxisch3VdBGC084wzZu05bz7D+CbtjEdPrrDa3+zaMqgt9ZdQcvOf2wB4zhHCfFPKrarzIwgccMdrNJHGCvKKwmiMnf4RMfuZZ+KJzBWu4X/hgS7eK9myxyo7jAG+Y0TLWtN0LhMa5x1dTCfZ8W5rNyzOL3bqtgf8+18csmguimVBwEITukPGMX+5ms24vKgfidcTkKRGyg790Xdf81avmd7PW5r06GH1FIQsWavT+EAAAAAElFTkSuQmCC"
const ICON_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACN0lEQVR4nOWWz0tUURTHP/e+MVNS8BfqJqGglFaiGxNCV25SalvSohZtXYar+hP6A4L2EuJKBSFonbhxYRsxxYJAhSJixpyRC98n10fj3Hnz3mw68Dhzzz1zft3vPedCGFlxU2W/mjxTslWcduYZhBW/CWwCz7VuEV8EvgEDCsDkEYAB1oEKMOc5ug2cAh+BQU83MzLiN+R8Tevr4s8kH09UJdcKTHvBuQr8BVaBrryPYAjYBkrAA29/QYFtAFEex+ADsR/4AhwDPZ6jVwrirdYukMypRXxSzp4m8PBB8natMwejFRjfy9Gol+19XcXNPI4hAq4BBeCOnC/JQZv230g+Jj2nn0vnc3SXf1NfYh1cAXOF3GU1AzwCWiX7rXP3geb0iqpISddyWQmUpRPrn4UEFYm/kPE032vPlqlR1UsUNxN3jl+VQVEtN+QrKcs/iWN5CUyFBGHEu4ETZVOuI3Nf955sDSoot/dYsosjtFUCiY2lpYp33g4bW0ruHdAr26ZWORq5yzGIHe0KzN81M2a1FwWBIgNyeDrSLClrrlyQbUIADpi31Kicvx0Cyt6lodMICEdkaxjYk2wf6PBHt80x8xgDPzQ9fwJPgF8+RgpNCMBVcl6jfCfRISkEGGjEOUL7in5fcl4rgChlEJXE8yy+csG9xer77A2a0FZc1H8O9X5I9U6MxCcEoHoHkWvhDxO2Uo/jAQ2R1hr6SN+9kj8BB4lumIpsM/5rAvbrfeWWGxxk/F90Dmx+uEqaKEXMAAAAAElFTkSuQmCC"

/**
 * Build the tray `NativeImage` with both @1x and @2x representations, flagged
 * as a template so macOS handles light/dark recoloring.
 */
export const createTrayImage = (): NativeImage => {
  const img = nativeImage.createFromBuffer(Buffer.from(ICON_1X, "base64"), {
    scaleFactor: 1,
  })
  img.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(ICON_2X, "base64"),
  })
  img.setTemplateImage(true)
  return img
}
