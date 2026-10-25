const HOST = "com.wong.pihole_companion";

export async function helperRequest(action) {
  if (!["start", "status"].includes(action)) throw new Error("Unsupported launcher action.");
  let result;
  try { result = await chrome.runtime.sendNativeMessage(HOST, { action }); }
  catch {
    throw new Error("Windows helper unavailable. Install or update the helper for this extension ID, and allow native messaging. See Setup Windows launcher below.");
  }
  if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string" || !["starting", "running", "stopped", "offline", "failed", "error"].includes(result.phase)) {
    throw new Error("Unexpected Windows helper response. Update the helper from this repository.");
  }
  if (!result.ok) throw new Error(result.message);
  return result;
}
