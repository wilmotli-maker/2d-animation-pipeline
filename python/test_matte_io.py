#!/usr/bin/env python3
"""Unit tests for matte_io.coverage_warnings (the method-agnostic quality guard).

Run: uv run --with numpy python -m pytest python/test_matte_io.py
 or: uv run --with numpy python python/test_matte_io.py   (plain asserts, no pytest)
Not part of `npm test` (that is node --test); the JS side mocks the sidecar.
"""
from matte_io import (coverage_warnings, COVERAGE_WARN_LO, COVERAGE_WARN_HI,
                      SOFT_WARN_HI)


def test_normal_matte_has_no_warnings():
    # A typical ml/chroma clip: ~25% coverage, a few percent soft.
    assert coverage_warnings(0.26, 0.01) == []
    assert coverage_warnings(0.26, 0.04) == []


def test_raw_keylight_is_not_flagged():
    # Raw keylight is inherently soft (~0.22 measured); it must not warn.
    assert coverage_warnings(0.25, 0.22) == []
    assert coverage_warnings(0.43, 0.22) == []  # robot-eyes-blue keylight


def test_low_coverage_warns():
    w = coverage_warnings(0.0, 0.0)
    assert len(w) == 1 and 'low coverage' in w[0]


def test_high_coverage_warns():
    w = coverage_warnings(1.0, 0.0)
    assert len(w) == 1 and 'high coverage' in w[0]


def test_high_soft_warns():
    w = coverage_warnings(0.26, 0.6)  # gradient-not-mask regime
    assert len(w) == 1 and 'soft-pixel' in w[0]


def test_bounds_are_inclusive_edges():
    # Exactly on the bound does not warn; just past it does.
    assert coverage_warnings(COVERAGE_WARN_LO, 0.0) == []
    assert coverage_warnings(COVERAGE_WARN_LO - 0.001, 0.0)
    assert coverage_warnings(COVERAGE_WARN_HI, 0.0) == []
    assert coverage_warnings(COVERAGE_WARN_HI + 0.001, 0.0)
    assert coverage_warnings(0.26, SOFT_WARN_HI) == []
    assert coverage_warnings(0.26, SOFT_WARN_HI + 0.001)


def test_multiple_warnings_combine():
    w = coverage_warnings(1.0, 0.9)
    assert len(w) == 2


if __name__ == '__main__':
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    for fn in fns:
        fn()
        print(f'ok  {fn.__name__}')
    print(f'\n{len(fns)} passed')
