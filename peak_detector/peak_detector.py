#!/usr/bin/env python3
"""Detect FTIR peaks independently for every spectrum.

Input and output are JSON over stdin/stdout. SciPy is used when available;
the small stdlib implementation keeps local development usable before SciPy
is installed.
"""

import json
import math
import statistics
import sys


try:
    from scipy.signal import find_peaks as scipy_find_peaks
    from scipy.signal import peak_widths as scipy_peak_widths
except ImportError:  # pragma: no cover - exercised on minimal installations
    scipy_find_peaks = None
    scipy_peak_widths = None

try:
    from pybaselines import Baseline as PyBaseline
except ImportError:  # pragma: no cover - local fallback when optional dependency is absent
    PyBaseline = None


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def moving_average(values, window):
    if window <= 1 or len(values) < 3:
        return list(values)
    half = window // 2
    result = []
    for index in range(len(values)):
        lo = max(0, index - half)
        hi = min(len(values), index + half + 1)
        result.append(sum(values[lo:hi]) / (hi - lo))
    return result


def linear_baseline(x_values, values):
    if len(values) < 2:
        return [0.0] * len(values)
    x0, x1 = x_values[0], x_values[-1]
    y0, y1 = values[0], values[-1]
    span = x1 - x0
    if not span:
        return [y0] * len(values)
    return [y0 + (y1 - y0) * ((x - x0) / span) for x in x_values]


def robust_x_step(x_values):
    """Return a representative spacing for a possibly uneven x-grid."""
    steps = [
        abs(x_values[index + 1] - x_values[index])
        for index in range(len(x_values) - 1)
        if x_values[index + 1] != x_values[index]
    ]
    return statistics.median(steps) if steps else 1.0


def estimate_baseline(x_values, values, settings):
    """Estimate a smooth background and keep a safe local fallback."""
    method = str(settings.get("baselineMethod", "arpls") or "arpls").lower()
    if method == "none":
        return [0.0] * len(values), "none", "none", None
    if method == "linear":
        return linear_baseline(x_values, values), "linear", "builtin", None
    if PyBaseline is None:
        return linear_baseline(x_values, values), "linear", "builtin-fallback", "pybaselines is not installed"

    try:
        fitter = PyBaseline(x_data=x_values, check_finite=True, assume_sorted=True)
        lam = min(1e12, max(1.0, float(settings.get("baselineLambda", 1e6) or 1e6)))
        asymmetry = min(0.5, max(1e-5, float(settings.get("baselineAsymmetry", 0.01) or 0.01)))
        if method == "arpls":
            baseline, _ = fitter.arpls(values, lam=lam)
        elif method == "airpls":
            baseline, _ = fitter.airpls(values, lam=lam)
        elif method == "asls":
            baseline, _ = fitter.asls(values, lam=lam, p=asymmetry)
        elif method == "snip":
            x_step = robust_x_step(x_values)
            half_window = max(1, int(round(float(settings.get("baselineSnipWindowCm1", 80) or 80) / x_step)))
            baseline, _ = fitter.snip(values, max_half_window=half_window)
        elif method == "rubberband":
            baseline, _ = fitter.rubberband(values)
        else:
            return linear_baseline(x_values, values), "linear", "builtin-fallback", "unknown baseline method: %s" % method
        return [float(value) for value in baseline], method, "pybaselines", None
    except Exception as error:  # pragma: no cover - depends on input and library version
        return linear_baseline(x_values, values), "linear", "builtin-fallback", "%s failed: %s" % (method, error)


def infer_signal_type(y_values, requested):
    """Infer the common FTIR export format when the client sends Auto.

    Most files opened by the web app are percent-transmittance exports.  They
    used to arrive as ``unknown`` and were therefore analysed as if their
    transmittance valleys were intensity maxima.  Keep explicit user choices
    authoritative and only infer the unambiguous percent-transmittance case.
    """
    requested = str(requested or "unknown").lower()
    if requested != "unknown":
        return requested
    if not y_values:
        return "unknown"
    minimum = min(y_values)
    maximum = max(y_values)
    span = maximum - minimum
    if minimum >= -1e-6 and maximum <= 110.0 and (maximum > 20.0 or span > 5.0):
        return "transmittance"
    return "unknown"


def fallback_find_peaks(values, min_distance, min_prominence, prominence_window=None):
    candidates = []
    window = max(3, prominence_window or min_distance * 2)
    for index in range(1, len(values) - 1):
        if values[index] <= values[index - 1] or values[index] < values[index + 1]:
            continue
        lo = max(0, index - window)
        hi = min(len(values), index + window + 1)
        prominence = values[index] - min(values[lo:hi])
        if prominence >= min_prominence:
            candidates.append((index, prominence))
    candidates.sort(key=lambda item: item[1], reverse=True)
    selected = []
    for index, prominence in candidates:
        if all(abs(index - other) >= min_distance for other in selected):
            selected.append(index)
    selected.sort()
    return selected, [values[index] - min(values[max(0, index - window):min(len(values), index + window + 1)]) for index in selected]


def merge_peak_candidates(primary_indices, primary_prominences, broad_indices, broad_prominences, min_distance_cm1, cross_engine_distance_cm1, x_values=None):
    """Merge duplicate maxima reported by the fine and broad passes.

    The two passes work on different signals, so the same physical band can
    be reported at adjacent samples.  Preserve the stronger candidate and
    use a slightly wider distance only when candidates came from different
    passes.  This avoids changing the user's fine peak separation setting for
    genuinely distinct peaks found by the same pass.
    """
    candidates = [
        (int(index), float(prominence), "primary")
        for index, prominence in zip(primary_indices, primary_prominences)
    ] + [
        (int(index), float(prominence), "broad")
        for index, prominence in zip(broad_indices, broad_prominences)
    ]
    candidates.sort(key=lambda item: item[1], reverse=True)
    selected = []
    coordinate = lambda index: x_values[index] if x_values and 0 <= index < len(x_values) else index
    for index, prominence, source in candidates:
        duplicate = False
        for other_index, _, other_source in selected:
            distance = cross_engine_distance_cm1 if source != other_source else min_distance_cm1
            if abs(coordinate(index) - coordinate(other_index)) < distance:
                duplicate = True
                break
        if not duplicate:
            selected.append((index, prominence, source))
    selected.sort(key=lambda item: item[0])
    return [item[0] for item in selected], [item[1] for item in selected], [item[2] for item in selected]


def x_at_index_position(x_values, position):
    """Interpolate a fractional sample position onto the actual x-grid."""
    if not x_values:
        return float(position)
    if position <= 0:
        return x_values[0]
    last = len(x_values) - 1
    if position >= last:
        return x_values[last]
    left = int(math.floor(position))
    fraction = position - left
    return x_values[left] + (x_values[left + 1] - x_values[left]) * fraction


def scipy_widths_cm1(x_values, values, indices):
    """Calculate widths in cm⁻¹, including uneven x-grid interpolation."""
    if scipy_peak_widths is None or not indices:
        return {}
    try:
        width_values, _, left_ips, right_ips = scipy_peak_widths(values, indices, rel_height=0.5)
        return {
            index: abs(x_at_index_position(x_values, right_ips[position]) - x_at_index_position(x_values, left_ips[position]))
            for position, index in enumerate(indices)
        }
    except Exception:
        return {}


def quality_flags(nu, width):
    """Mark common FTIR nuisance regions without silently deleting candidates."""
    flags = []
    if 2280 <= nu <= 2400:
        flags.append("possible_atmospheric_co2")
    if nu < 500:
        flags.append("possible_low_frequency_artifact")
    if width is None:
        flags.append("width_unresolved")
    return flags


def local_fwhm(x_values, values, index, baseline_value):
    peak_height = values[index] - baseline_value
    if peak_height <= 0:
        return None
    half_level = baseline_value + peak_height / 2.0
    left = index
    right = index
    while left > 0 and values[left] > half_level:
        left -= 1
    while right < len(values) - 1 and values[right] > half_level:
        right += 1
    width = abs(x_values[right] - x_values[left])
    return width if width > 0 else None


def peak_shape(width):
    if width is None:
        return "unknown"
    if width <= 20:
        return "sharp"
    if width >= 80:
        return "broad"
    return "band"


def manual_measurements(spectrum_id, x_values, signal, corrected, broad_corrected, settings):
    """Measure user-requested peak positions without applying detector thresholds.

    Automatic detection is intentionally conservative. A manual marker is an
    explicit user instruction, so it is snapped only to the nearest local
    absorption maximum and is always measured, even when its prominence is
    below the automatic detector threshold.
    """
    positions_by_spectrum = settings.get("manualPositionsBySpectrum") or {}
    requested_positions = positions_by_spectrum.get(spectrum_id) or []
    try:
        snap_cm1 = max(2.0, min(60.0, float(settings.get("manualSnapCm1", 18.0) or 18.0)))
    except (TypeError, ValueError):
        snap_cm1 = 18.0
    results = []
    for requested in requested_positions:
        if not finite(requested):
            continue
        requested = float(requested)
        nearest = min(range(len(x_values)), key=lambda index: abs(x_values[index] - requested))
        nearby = [
            index for index, x_value in enumerate(x_values)
            if abs(x_value - requested) <= snap_cm1
        ]
        # FTIR transmittance has already been converted to absorbance here,
        # therefore a local maximum is the absorption-band apex.
        index = max(nearby or [nearest], key=lambda item: signal[item])
        fine_width = scipy_widths_cm1(x_values, corrected, [index]).get(index)
        if fine_width is None:
            fine_width = local_fwhm(x_values, corrected, index, 0.0)
        broad_width = scipy_widths_cm1(x_values, broad_corrected, [index]).get(index)
        if broad_width is None:
            broad_width = local_fwhm(x_values, broad_corrected, index, 0.0)
        # The broad pass is kept specifically for OH/NH-like bands; preserve
        # its larger FWHM when it is the more informative measurement.
        available_widths = [width for width in (fine_width, broad_width) if width is not None and width > 0]
        width = max(available_widths) if available_widths else None
        local_span = max(3, int(round(80.0 / max(robust_x_step(x_values), 1e-9))))
        left_floor = min(corrected[max(0, index - local_span):index + 1])
        right_floor = min(corrected[index:min(len(corrected), index + local_span + 1)])
        prominence = max(0.0, corrected[index] - max(left_floor, right_floor))
        local_values = corrected[max(0, index - local_span):min(len(corrected), index + local_span + 1)]
        local_range = max(local_values) - min(local_values) if local_values else 0.0
        lo = max(0, index - max(8, local_span // 2))
        hi = min(len(x_values), index + max(8, local_span // 2) + 1)
        flags = quality_flags(x_values[index], width)
        results.append({
            "requestedNu": round(requested, 4),
            "nu": round(x_values[index], 4),
            "originalNu": round(x_values[index], 4),
            "height": round(max(0.0, corrected[index]), 6),
            "prominence": round(prominence, 6),
            "widthCm1": round(float(width), 4) if width is not None else None,
            "fwhmCm1": round(float(width), 4) if width is not None else None,
            "shape": peak_shape(width),
            "direction": "absorption",
            "confidence": round(min(1.0, prominence / local_range), 4) if local_range > 0 else 0.0,
            "qualityFlags": flags,
            "localWindow": [[x_values[item], signal[item]] for item in range(lo, hi)],
        })
    return results


def detect_spectrum(spectrum, settings):
    points = []
    for item in spectrum.get("points", []):
        if isinstance(item, list) and len(item) == 2 and finite(item[0]) and finite(item[1]):
            points.append((float(item[0]), float(item[1])))
    points.sort(key=lambda point: point[0])
    if len(points) < 5:
        return [], ["%s: fewer than 5 valid points" % spectrum.get("id", "spectrum")], {
            "baselineMethod": "none",
            "baselineEngine": "none",
            "signalType": "unknown",
            "displayYUnit": "unknown",
            "diagnostics": {"x": [], "signal": [], "baseline": [], "corrected": [], "broadCorrected": []},
        }

    x_values = [point[0] for point in points]
    y_values = [point[1] for point in points]
    signal_type = spectrum.get("signalType", "unknown")
    if signal_type == "unknown":
        signal_type = settings.get("signalType", "unknown")
    signal_type = infer_signal_type(y_values, signal_type)

    if signal_type == "transmittance":
        maximum = max(y_values)
        transmittance = [value * 100.0 if maximum <= 2.0 else value for value in y_values]
        signal = [math.log10(100.0 / max(value, 1e-9)) for value in transmittance]
    else:
        signal = list(y_values)

    smoothing_window = int(settings.get("smoothingWindow", 5) or 1)
    if smoothing_window % 2 == 0:
        smoothing_window += 1
    smoothing_window = max(1, min(101, smoothing_window))
    smoothed = moving_average(signal, smoothing_window)
    baseline, baseline_method, baseline_engine, baseline_warning = estimate_baseline(x_values, smoothed, settings)
    corrected = [value - base for value, base in zip(smoothed, baseline)]

    x_step = robust_x_step(x_values)
    min_separation = float(settings.get("minSeparationCm1", 8.0) or 8.0)
    min_distance_samples = max(1, int(round(min_separation / x_step)))
    min_prominence = float(settings.get("minProminence", 0.02) or 0.0)
    max_peaks = int(settings.get("maxPeaks", 200) or 200)
    broad_window_cm1 = max(50.0, float(settings.get("broadProminenceWindowCm1", 800) or 800))
    broad_window_samples = max(min_distance_samples * 8, int(round(broad_window_cm1 / x_step)))
    broad_smoothing_window = int(settings.get("broadSmoothingWindow", 31) or 31)
    if broad_smoothing_window % 2 == 0:
        broad_smoothing_window += 1
    broad_smoothing_window = max(3, min(101, broad_smoothing_window))
    broad_distance_samples = max(
        min_distance_samples,
        int(round(float(settings.get("broadMinSeparationCm1", 180) or 180) / x_step)),
    )
    broad_smoothed = moving_average(signal, broad_smoothing_window)
    # The adaptive baseline used by the fine pass can correctly treat a very
    # broad OH/NH band as background.  The broad pass must retain that shape,
    # so use only a simple endpoint trend here.  This pass is intentionally a
    # band-preservation pass, not a second copy of the fine baseline fit.
    broad_baseline = (
        [0.0] * len(broad_smoothed)
        if str(settings.get("broadBaselineMethod", "linear") or "linear").lower() == "none"
        else linear_baseline(x_values, broad_smoothed)
    )
    broad_baseline_warning = None
    broad_corrected = [value - base for value, base in zip(broad_smoothed, broad_baseline)]

    properties = {}
    if scipy_find_peaks is not None:
        peak_indices, properties = scipy_find_peaks(
            corrected,
            distance=min_distance_samples,
            prominence=min_prominence,
            wlen=min(len(corrected), max(3, min_distance_samples * 8)),
        )
        broad_indices, broad_properties = scipy_find_peaks(
            broad_corrected,
            distance=broad_distance_samples,
            prominence=min_prominence,
            wlen=min(len(corrected), max(3, broad_window_samples)),
        )
        peak_indices, prominences, sources = merge_peak_candidates(
            peak_indices,
            properties.get("prominences", []),
            broad_indices,
            broad_properties.get("prominences", []),
            min_separation,
            float(settings.get("crossEngineMergeCm1", 20) or 20),
            x_values,
        )
    else:
        primary_indices, primary_prominences = fallback_find_peaks(corrected, min_distance_samples, min_prominence, min_distance_samples * 2)
        broad_indices, broad_prominences = fallback_find_peaks(broad_corrected, broad_distance_samples, min_prominence, broad_window_samples)
        peak_indices, prominences, sources = merge_peak_candidates(
            primary_indices,
            primary_prominences,
            broad_indices,
            broad_prominences,
            min_separation,
            float(settings.get("crossEngineMergeCm1", 20) or 20),
            x_values,
        )

    search_range = settings.get("searchRangeCm1") or {}
    try:
        search_min = float(search_range.get("min"))
        search_max = float(search_range.get("max"))
        if not math.isfinite(search_min) or not math.isfinite(search_max):
            raise ValueError
        search_min, search_max = min(search_min, search_max), max(search_min, search_max)
    except (AttributeError, TypeError, ValueError):
        search_min, search_max = x_values[0], x_values[-1]
    in_search_range = [
        position for position, index in enumerate(peak_indices)
        if search_min <= x_values[index] <= search_max
    ]
    peak_indices = [peak_indices[position] for position in in_search_range]
    prominences = [prominences[position] for position in in_search_range]
    sources = [sources[position] for position in in_search_range]

    ranked = sorted(zip(peak_indices, prominences, sources), key=lambda item: item[1], reverse=True)[:max_peaks]
    ranked.sort(key=lambda item: x_values[item[0]], reverse=True)
    max_prominence = max((float(item[1]) for item in ranked), default=1.0)
    results = []

    widths = {}
    for source, values in (("primary", corrected), ("broad", broad_corrected)):
        source_indices = [index for index, _, candidate_source in ranked if candidate_source == source]
        for index, width in scipy_widths_cm1(x_values, values, source_indices).items():
            widths[(source, index)] = width

    for index, prominence, source in ranked:
        values = broad_corrected if source == "broad" else corrected
        width = widths.get((source, index)) or local_fwhm(x_values, values, index, 0.0)
        nu = x_values[index]
        shape = peak_shape(width)
        lo = max(0, index - max(4, min_distance_samples * 2))
        hi = min(len(points), index + max(4, min_distance_samples * 2) + 1)
        local_window = [[x_values[item], y_values[item]] for item in range(lo, hi)]
        flags = quality_flags(nu, width)
        results.append({
            "id": "peak-%s-%s" % (spectrum["id"], str(round(nu, 2)).replace(".", "_")),
            "spectrumId": spectrum["id"],
            "nu": round(nu, 4),
            "originalNu": round(nu, 4),
            "height": round(values[index], 6),
            "prominence": round(float(prominence), 6),
            "widthCm1": round(float(width), 4) if width is not None else None,
            "fwhmCm1": round(float(width), 4) if width is not None else None,
            "shape": shape,
            "direction": "absorption",
            "detectionMethod": "automatic",
            "confidence": round(min(1.0, max(0.0, float(prominence) / max_prominence)), 4),
            "qualityFlags": flags,
            "localWindow": local_window,
        })
    measured_manual = manual_measurements(
        spectrum.get("id"), x_values, smoothed, corrected, broad_corrected, settings
    )
    warnings = []
    if baseline_warning:
        warnings.append("%s: %s" % (spectrum.get("id", "spectrum"), baseline_warning))
    if broad_baseline_warning and broad_baseline_warning != baseline_warning:
        warnings.append("%s broad pass: %s" % (spectrum.get("id", "spectrum"), broad_baseline_warning))
    diagnostic_stride = max(1, int(math.ceil(len(points) / 1200)))
    diagnostics = {
        "x": [round(x_values[index], 6) for index in range(0, len(points), diagnostic_stride)],
        "signal": [round(signal[index], 8) for index in range(0, len(points), diagnostic_stride)],
        "baseline": [round(baseline[index], 8) for index in range(0, len(points), diagnostic_stride)],
        "corrected": [round(corrected[index], 8) for index in range(0, len(points), diagnostic_stride)],
        "broadCorrected": [round(broad_corrected[index], 8) for index in range(0, len(points), diagnostic_stride)],
    }
    if signal_type == "transmittance":
        # Keep the main chart in the user's original %T scale while peak
        # search continues in absorbance space.
        display_corrected = [100.0 * math.pow(10.0, min(6.0, max(-6.0, -value))) for value in corrected]
        display_y_unit = "%T"
    else:
        display_corrected = corrected
        display_y_unit = signal_type
    diagnostics["displayCorrected"] = [round(display_corrected[index], 8) for index in range(0, len(points), diagnostic_stride)]
    return results, warnings, {
        "baselineMethod": baseline_method,
        "baselineEngine": baseline_engine,
        "signalType": signal_type,
        "displayYUnit": display_y_unit,
        "searchRangeCm1": {"min": search_min, "max": search_max},
        "manualMeasurements": measured_manual,
        "diagnostics": diagnostics,
    }


def main():
    try:
        payload = json.load(sys.stdin)
        if payload.get("schemaVersion") != "2.0":
            raise ValueError("Unsupported schemaVersion")
        settings = payload.get("settings") or {}
        observations = []
        warnings = []
        processing = []
        for spectrum in payload.get("spectra", []):
            peaks, spectrum_warnings, spectrum_processing = detect_spectrum(spectrum, settings)
            observations.extend(peaks)
            warnings.extend(spectrum_warnings)
            processing.append({"spectrumId": spectrum.get("id"), **spectrum_processing})
        json.dump({
            "schemaVersion": "2.0",
            "peakObservations": observations,
            "settings": settings,
            "warnings": warnings,
            "engine": "scipy.signal.find_peaks" if scipy_find_peaks is not None else "stdlib-fallback",
            "processing": processing,
        }, sys.stdout)
    except Exception as error:
        json.dump({"error": str(error)}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
