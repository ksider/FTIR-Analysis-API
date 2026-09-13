const finiteNumber = (value) => (
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null
);

function normalizeObservation(observation, index = 0) {
  if (!observation || typeof observation !== 'object') return null;
  const nu = finiteNumber(observation.nu ?? observation.x);
  const spectrumId = observation.spectrumId ? String(observation.spectrumId) : '';
  if (nu === null || !spectrumId) return null;
  return {
    ...observation,
    id: String(observation.id || `peak-${spectrumId}-${index + 1}`),
    spectrumId,
    nu,
    prominence: finiteNumber(observation.prominence),
    height: finiteNumber(observation.height),
    widthCm1: finiteNumber(observation.widthCm1),
    fwhmCm1: finiteNumber(observation.fwhmCm1),
    confidence: finiteNumber(observation.confidence),
  };
}

function groupPeaks(observations, toleranceCm1 = 8) {
  const tolerance = Math.max(0.1, Number(toleranceCm1) || 8);
  const normalized = observations.map((observation, index) => normalizeObservation(observation, index)).filter(Boolean).sort((a, b) => b.nu - a.nu);
  const groups = [];

  normalized.forEach((observation) => {
    const matching = groups
      .filter((group) => !group.members.some((member) => member.spectrumId === observation.spectrumId))
      .map((group) => ({ group, distance: Math.abs(group.centerNu - observation.nu) }))
      .filter((candidate) => candidate.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance);
    const target = matching[0]?.group || { centerNu: observation.nu, members: [] };
    if (!target.members.length) groups.push(target);
    target.members.push(observation);
    target.centerNu = target.members.reduce((sum, member) => sum + member.nu, 0) / target.members.length;
  });

  return groups
    .sort((a, b) => b.centerNu - a.centerNu)
    .map((group, index) => ({
      id: `group-${String(Math.round(group.centerNu)).replace('-', 'm')}-${index + 1}`,
      centerNu: Number(group.centerNu.toFixed(4)),
      toleranceCm1: tolerance,
      members: group.members.map((member) => ({
        spectrumId: member.spectrumId,
        peakId: member.id,
      })),
      observations: group.members,
    }));
}

function buildComparisonMatrix(spectra, observations, settings = {}) {
  const toleranceCm1 = Math.max(0.1, Number(settings.toleranceCm1) || 8);
  const shiftThresholdCm1 = Math.max(0.1, Number(settings.shiftThresholdCm1) || 2);
  const prominenceChangeThreshold = Math.max(0, Number(settings.prominenceChangeThreshold) || 0.05);
  const widthChangeThreshold = Math.max(0, Number(settings.widthChangeThreshold) || 1);
  const spectrumMeta = (spectra || []).filter((spectrum) => spectrum && spectrum.id).map((spectrum) => ({
    ...spectrum,
    id: String(spectrum.id),
  }));
  const spectrumIds = spectrumMeta.map((spectrum) => spectrum.id);
  const normalized = observations.map((observation, index) => normalizeObservation(observation, index)).filter(Boolean);
  const groups = groupPeaks(normalized, toleranceCm1);
  const changes = [];
  const baselineSpectrumId = spectrumMeta.find((spectrum) => spectrum.role === 'before')?.id
    || spectrumIds[0]
    || normalized[0]?.spectrumId
    || null;
  const comparisonSpectrumIds = spectrumIds.filter((spectrumId) => spectrumId !== baselineSpectrumId);
  const matrix = [];

  groups.forEach((group) => {
    const bySpectrum = new Map(group.observations.map((observation) => [observation.spectrumId, observation]));
    const presence = spectrumIds.map((spectrumId) => {
      const observation = bySpectrum.get(spectrumId) || null;
      return {
        spectrumId,
        present: Boolean(observation),
        peakId: observation?.id || null,
        nu: observation?.nu ?? null,
        prominence: observation?.prominence ?? null,
        fwhmCm1: observation?.fwhmCm1 ?? null,
        widthCm1: observation?.widthCm1 ?? null,
      };
    });
    matrix.push({
      groupId: group.id,
      centerNu: group.centerNu,
      presence,
    });
    if (!baselineSpectrumId) return;
    const baseline = bySpectrum.get(baselineSpectrumId) || null;
    comparisonSpectrumIds.forEach((spectrumId) => {
      const current = bySpectrum.get(spectrumId) || null;
      if (baseline && !current) {
        changes.push({
          type: 'disappeared_peak',
          groupId: group.id,
          fromSpectrumId: baselineSpectrumId,
          toSpectrumId: spectrumId,
          fromNu: baseline.nu,
          toNu: null,
          nu: baseline.nu,
        });
      } else if (!baseline && current) {
        changes.push({
          type: 'appeared_peak',
          groupId: group.id,
          fromSpectrumId: baselineSpectrumId,
          toSpectrumId: spectrumId,
          fromNu: null,
          toNu: current.nu,
          nu: current.nu,
        });
      } else if (baseline && current) {
        const deltaNu = Number((current.nu - baseline.nu).toFixed(4));
        const deltaProminence = baseline.prominence !== null && current.prominence !== null
          ? Number((current.prominence - baseline.prominence).toFixed(4))
          : null;
        const deltaFwhm = baseline.fwhmCm1 !== null && current.fwhmCm1 !== null
          ? Number((current.fwhmCm1 - baseline.fwhmCm1).toFixed(4))
          : null;
        if (Math.abs(deltaNu) >= shiftThresholdCm1) {
          changes.push({ type: 'shifted_peak', groupId: group.id, fromSpectrumId: baselineSpectrumId, toSpectrumId: spectrumId, fromNu: baseline.nu, toNu: current.nu, deltaNu });
        }
        if (deltaProminence !== null && Math.abs(deltaProminence) >= prominenceChangeThreshold) {
          changes.push({
            type: 'prominence_change',
            groupId: group.id,
            fromSpectrumId: baselineSpectrumId,
            toSpectrumId: spectrumId,
            nu: current.nu,
            fromProminence: baseline.prominence,
            toProminence: current.prominence,
            deltaProminence,
          });
        }
        if (deltaFwhm !== null && Math.abs(deltaFwhm) >= widthChangeThreshold) {
          changes.push({
            type: 'width_change',
            groupId: group.id,
            fromSpectrumId: baselineSpectrumId,
            toSpectrumId: spectrumId,
            nu: current.nu,
            fromFwhmCm1: baseline.fwhmCm1,
            toFwhmCm1: current.fwhmCm1,
            deltaFwhm,
          });
        }
      }
    });
  });

  return {
    baselineSpectrumId,
    spectrumIds,
    comparisonSpectrumIds,
    toleranceCm1,
    shiftThresholdCm1,
    prominenceChangeThreshold,
    widthChangeThreshold,
    matrix,
    groups: groups.map(({ observations: _observations, ...group }) => group),
    changes,
  };
}

module.exports = { buildComparisonMatrix, groupPeaks, normalizeObservation };
