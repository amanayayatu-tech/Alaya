# Alaya Cognition Experiment Postrun Result

Generated at: 2026-06-16T16:22:40.216Z
Preregistration: validation-logs/EXPERIMENT_PREREG_20260616_001359.md

## Run Directories

- Baseline: validation-logs/shadow-24h_base_20260616_001359
- Treatment: validation-logs/shadow-24h_treat_20260616_001359

## Readiness

- Baseline summary: present
- Treatment summary: present
- Baseline quality_summary: present
- Treatment quality_summary: present
- Baseline analyzer output: present
- Treatment analyzer output: present

## Metrics

| arm | durationHours | samples | hardErrors | schemaDegradation | cc.status | cc.ece | cc.scored | cc.eligible | faith.status | faithfulness | faith.scored | faith.eligible | decision.status | disallowed |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | ---: |
| baseline | n/a | 288 | 2 | 0 | low_coverage | 0.005599 | 2 | 2 | low_coverage | 0.857143 | 14 | 2 | pass | 0 |
| treatment | n/a | 201 | 2 | 4 | low_coverage | 0.155621 | 2 | 2 | low_coverage | 0.75 | 16 | 2 | pass | 0 |

## Preregistered Preconditions

- confidenceCalibration.scored >= 30: baseline=2, treatment=2
- faithfulness.eligible >= 30: baseline=2, treatment=2

## Primary Metric Comparison

- ECE absolute delta (baseline - treatment): -0.150022
- ECE relative delta: -2679.44%
- Treatment lower ECE: false

## Cognition Conclusion

覆盖不足,不可下结论

## Notes

- This report is generated from final analyzer artifacts only. If readiness is pending, no conclusion is valid yet.
- The 24h acceptance conclusion must still be read from the treatment arm analyzer findings and not inferred from this cognition comparison.
- The preregistered treatment variable is MINIMAX_THINKING=adaptive; baseline is MINIMAX_THINKING=disabled.

