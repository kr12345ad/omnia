// All computer-control API calls now go to the hosted control plane with the
// authenticated client token; the embedded local server no longer exists.
import { controlPlaneCall } from "./control-plane"

export async function serverCall(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<Record<string, unknown>> {
  return controlPlaneCall(path, method, body)
}
