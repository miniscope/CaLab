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
        """Launch the browser. Called automatically by ``__enter__``."""
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=self._headless,
            # Allow the HTTPS-hosted page to fetch from the localhost bridge
            # server. Headless Chromium enforces Private Network Access (PNA)
            # restrictions that block HTTPS→localhost requests by default.
            args=["--disable-web-security"],
        )
        self._context = self._browser.new_context()
        self._page = self._context.new_page()

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
        """Shut down page, context, browser, and Playwright."""
        if self._context is not None:
            self._context.close()
            self._context = None
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        if self._pw is not None:
            self._pw.stop()
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
