import { describe, expect, test } from "bun:test"
import { CdpError } from "./cdp"
import { ImageFileError } from "./image-file"
import { BrowserUrlError } from "./url-policy"
import { browserFailure, browserFailureStatus } from "./errors"

describe("browser failure mapping", () => {
  test("maps controller codes to non-retryable client errors", () => {
    expect(browserFailure(new CdpError("element_not_found", "gone"))).toMatchObject({
      code: "element_not_found",
      httpStatus: 404,
      retryable: false,
    })
    expect(browserFailure(new CdpError("invalid_key", "bad key"))).toMatchObject({ httpStatus: 400, retryable: false })
    expect(browserFailure(new ImageFileError("path_blocked", "outside downloads"))).toMatchObject({
      httpStatus: 400,
      retryable: false,
    })
    expect(browserFailure(new BrowserUrlError("blocked"))).toMatchObject({ httpStatus: 400, retryable: false })
  })

  test("maps transient failures to retryable gateway errors", () => {
    expect(browserFailure(new CdpError("connection_closed", "closed"))).toMatchObject({
      httpStatus: 503,
      retryable: true,
    })
    expect(browserFailure(new CdpError("load_timeout", "slow"))).toMatchObject({ httpStatus: 504, retryable: true })
    expect(browserFailure(new CdpError("busy", "too many commands"))).toMatchObject({
      httpStatus: 503,
      retryable: true,
    })
    expect(browserFailure(new Error("boom"))).toMatchObject({
      code: "browser_error",
      httpStatus: 500,
      retryable: false,
    })
  })

  test("keeps an unknown code generic", () => {
    expect(browserFailureStatus("something_new")).toBe(500)
  })
})
