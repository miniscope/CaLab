"""Pydantic models for CaDecon bridge configuration."""

from __future__ import annotations

from pydantic import BaseModel, Field


class DeconConfig(BaseModel):
    """Configuration for automated CaDecon deconvolution via the bridge.

    Fields map 1:1 to the BridgeConfig TypeScript interface in @calab/io.
    Only ``autorun`` is always serialized; all other fields use
    ``exclude_none=True`` so absent values fall through to browser defaults.
    """

    autorun: bool = Field(False, description="Auto-start solver after loading traces")
    upsample_target: int | None = Field(
        None, gt=0, description="Target sampling rate (Hz) for upsampling"
    )
    hp_filter_enabled: bool | None = Field(None, description="Enable high-pass filter")
    lp_filter_enabled: bool | None = Field(None, description="Enable low-pass filter")
    max_iterations: int | None = Field(
        None, gt=0, le=200, description="Maximum solver iterations (1-200)"
    )
    convergence_tol: float | None = Field(
        None, gt=0, lt=1, description="Convergence tolerance (0-1 exclusive)"
    )
    num_subsets: int | None = Field(
        None, gt=0, description="Number of random subsets for optimization"
    )
    target_coverage: float | None = Field(
        None, gt=0, le=1, description="Fraction of data covered by subsets (0-1]"
    )
    aspect_ratio: float | None = Field(
        None, gt=0, description="Subset aspect ratio (>1 = wider, <1 = taller)"
    )
    seed: int | None = Field(None, description="Random seed for subset placement")
