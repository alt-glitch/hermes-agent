/**
 * The widget sdk — everything a user widget may touch, passed INTO its
 * `register(sdk)` (user files have no resolvable import path to the bundle).
 * Same member set as the Ink engine's `ui-tui/src/sdk/userWidgets.ts`
 * `widgetSdk`, so one template contract runs on both engines. `sdk.React` is
 * the runtime's hook shim (createElement/useState/useEffect/useMemo/useRef/
 * useCallback — the surface the tui-widgets skill documents).
 */
import {
  Accordion,
  Dialog,
  GridAreas,
  Overlay,
  Shimmer,
  ShimmerRows,
  useShimmerPhase,
  WidgetGrid
} from './components.ts'
import { gauge, hbars, sparkline, sparkRows } from './charts.ts'
import { Box, Fragment, h, Text } from './element.ts'
import { openWidget, updateWidget } from './host.ts'
import { defineWidgetApp } from './registry.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from './runtime.ts'
import { isCtrl } from './types.ts'

/** React-compatible hook/createElement shim (the widget runtime implements
 *  these natively — see runtime.ts). */
export const WidgetReact = {
  Fragment,
  createElement: h,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} as const

export const widgetSdk = {
  Accordion,
  Box,
  Dialog,
  GridAreas,
  Overlay,
  React: WidgetReact,
  Shimmer,
  ShimmerRows,
  Text,
  WidgetGrid,
  defineWidgetApp,
  gauge,
  h,
  hbars,
  isCtrl,
  openWidget,
  sparkRows,
  sparkline,
  updateWidget,
  useShimmerPhase
} as const

export type WidgetSdk = typeof widgetSdk
