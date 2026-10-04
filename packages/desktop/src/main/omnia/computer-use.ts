import { ipcMain } from "electron"
import { controlPlaneCall } from "./control-plane"

function modelPath(id: string): string {
  return `/v1/computer-use/models/${encodeURIComponent(id)}`
}

export function registerComputerUseIpcHandlers(): void {
  ipcMain.handle("computer-use-models", async () => (await controlPlaneCall("/v1/computer-use/models", "GET")).models ?? [])
  ipcMain.handle("computer-use-status", async () => (await controlPlaneCall("/v1/computer-use/status", "GET")).status)
  ipcMain.handle("computer-use-settings", async () => (await controlPlaneCall("/v1/computer-use/settings", "GET")).settings)
  ipcMain.handle("computer-use-settings-update", async (_event, patch: unknown) => {
    const json = await controlPlaneCall("/v1/computer-use/settings", "POST", patch)
    return json.settings
  })
  ipcMain.handle("computer-use-model-download", async (_event, id: string) => {
    const json = await controlPlaneCall(`${modelPath(id)}/download`, "POST", {})
    return json.started === true
  })
  ipcMain.handle("computer-use-model-load", async (_event, id: string) => {
    const json = await controlPlaneCall(`${modelPath(id)}/load`, "POST", {})
    return json.model
  })
  ipcMain.handle("computer-use-model-unload", async (_event, id: string) => {
    const json = await controlPlaneCall(`${modelPath(id)}/unload`, "POST", {})
    return json.unloaded === true
  })
  ipcMain.handle("computer-use-model-remove", async (_event, id: string) => {
    const json = await controlPlaneCall(modelPath(id), "DELETE")
    return json.removed === true
  })
  ipcMain.handle("computer-use-runtimes", async () => (await controlPlaneCall("/v1/computer-use/runtimes", "GET")).runtimes ?? [])
  ipcMain.handle("computer-use-runtime-download", async (_event, id: string) => {
    const json = await controlPlaneCall(`/v1/computer-use/runtimes/${encodeURIComponent(id)}/download`, "POST", {})
    return json.started === true
  })
  ipcMain.handle("computer-use-runtime-remove", async (_event, id: string) => {
    const json = await controlPlaneCall(`/v1/computer-use/runtimes/${encodeURIComponent(id)}`, "DELETE")
    return json.removed === true
  })
  ipcMain.handle("computer-use-calibration", async () => (await controlPlaneCall("/v1/computer-use/calibration", "GET")).calibration)
  ipcMain.handle("computer-use-calibration-start", async () => {
    const json = await controlPlaneCall("/v1/computer-use/calibration/start", "POST", {})
    return { screen: json.screen, points: json.points }
  })
  ipcMain.handle("computer-use-calibration-measure", async (_event, pointId: string) => {
    const json = await controlPlaneCall("/v1/computer-use/calibration/measure", "POST", { pointId })
    return json.measurement
  })
  ipcMain.handle("computer-use-calibration-save", async (_event, measurements: unknown) => {
    const json = await controlPlaneCall("/v1/computer-use/calibration/save", "POST", { measurements })
    return json.profile
  })
  ipcMain.handle("computer-use-calibration-reset", async () => {
    await controlPlaneCall("/v1/computer-use/calibration", "DELETE")
    return true
  })
}
