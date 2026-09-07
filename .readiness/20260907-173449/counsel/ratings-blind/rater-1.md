| report | evidence | regression_catch | false_positive_risk | actionability | best_unique | overreach |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| A | 3 | 4 | 5 | 3 | none | none |
| B | 5 | 5 | 5 | 5 | none | none |
| C | 5 | 5 | 5 | 4 | none | “one-command fix” is asserted without naming the command |
| D | 1 | 1 | 5 | 1 | none | none |

A–C converge on the same valid P2 build-gate finding, so none is uniquely discovered.
B gives the strongest trace from byte comparison through the required lint gate.
D makes no claims, so false-positive risk is low, but it provides no evidence, coverage, or action.
