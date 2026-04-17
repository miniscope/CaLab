"""Headless browser management via Playwright (optional dependency).

All Playwright imports are deferred so this module can be imported even when
Playwright is not installed — the check only fires on ``HeadlessBrowser()``
instantiation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.sync_api import Browser, BrowserContext, Page, Playwright


def _check_playwright() -> None:
    """Raise ImportError with actionable message if Playwright is missing."""
    try:
        import playwright  # noqa: F401
    except ImportError:
        raise ImportError(
            "Playwright is required for headless mode. Install with:\n"
            "  pip install calab[headless]\n"
            "  playwright install chromium"
        ) from None


class HeadlessBrowser:
    """Manages a Playwright browser for headless CaDecon / CaTune runs.

    Can be used as a context manager for single runs, or kept alive
    across multiple ``decon()`` / ``tune()`` calls for batch processing.

    Examples
    --------
    Single run::

        with HeadlessBrowser() as hb:
            result = calab.decon(traces, fs, headless=hb, autorun=True)

    Batch (reuses browser across datasets)::

        with HeadlessBrowser() as hb:
            for traces in datasets:
                result = calab.decon(traces, fs, headless=hb, autorun=True)
    """

    def __init__(self, *, visible: bool = False) -> None:
        _check_playwright()
        self._headless = not visible
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    # -- context manager ----------------------------------------------------

    def __enter__(self) -> HeadlessBrowser:
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Launch the browser. Called automatically by ``__enter__``.

        If any initialization step raises after earlier steps succeeded,
        ``close()`` runs before re-raising. This prevents partial-init
        failures (e.g. Chromium launch fails after the Playwright driver
        started) from leaking driver processes and Chromium instances
        across retries.
        """
        from playwright.sync_api import sync_playwright

        try:
            self._pw = sync_playwright().start()
            # No --disable-web-security: the bridge server answers PNA
            # preflights with `Access-Control-Allow-Private-Network: true`,
            # so Chromium allows the HTTPS→localhost fetch without needing
            # SOP disabled globally. See `_server.py` OPTIONS handler.
            self._browser = self._pw.chromium.launch(headless=self._headless)
            self._context = self._browser.new_context()
            self._page = self._context.new_page()
        except Exception:
            self.close()
            raise

    def navigate(self, url: str) -> None:
        """Navigate the managed page to *url*.

        If the page is already on a different URL, it navigates there
        (effectively reusing the same tab).
        """
        if self._page is None:
            raise RuntimeError(
                "Browser not started. Call start() or use as context manager."
            )
        self._page.goto(url, wait_until="domcontentloaded")

    def close(self) -> None:
        """Shut down page, context, browser, and Playwright.

        Each teardown runs in its own try/except so a crashed browser
        (where ``context.close()`` raises) still lets ``browser.close()``
        and ``pw.stop()`` run. Without this, a single teardown error
        would leak the remaining resources — most visibly an orphaned
        Chromium process that lingers until the Python process exits.
        """
        if self._context is not None:
            try:
                self._context.close()
            except Exception:
                pass
            self._context = None
        if self._browser is not None:
            try:
                self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._pw is not None:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None
        self._page = None

    # -- properties ---------------------------------------------------------

    @property
    def page(self) -> Page:
        """The managed Playwright ``Page`` (raises if not started)."""
        if self._page is None:
            raise RuntimeError("Browser not started.")
        return self._page

    @property
    def is_alive(self) -> bool:
        """Whether the browser is still connected."""
        return self._browser is not None and self._browser.is_connected()
