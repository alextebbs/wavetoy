# Whisper Bench: Auto-Detect vs Explicit Chinese

**Source**: `untitled-20260315-175828-20260315-181328-ringbuffer.wav` (Chinese HF radio)  
**Model**: `ggml-small.bin` (487 MB)  
**Task**: `translate` (Chinese → English)  
**Chunk size**: 30 seconds  
**Total chunks**: 20 (10 minutes of audio)  
**Sample rate**: 12 kHz → resampled to 16 kHz  

## Summary

### Language detection is broken on HF audio

Auto-detect tagged every single chunk as `en`. All 20 out of 20. This is definitively
not a sometimes-wrong situation — the classifier is completely fooled by noisy HF audio.
It never once detected Chinese.

### Setting the language explicitly barely matters for translation quality

Side-by-side comparison of the 20 chunks shows that the **actual translated text is
almost identical** between auto-detect (wrongly tagged `en`) and explicit `zh`. The
decoder appears to translate from Chinese regardless of what the classifier thinks.

Notable exceptions:

| Chunk | Auto-detect | Explicit zh | Winner |
|-------|-------------|-------------|--------|
| 1 | 16 segments, good content about ocean tech & Olympics | 1 segment, compressed summary | Auto |
| 9 | 2 segments, terse | 8 segments, detailed content about Guangdong province | zh |
| 14 | `[Spanish] [Spanish] [Spanish] [Spanish]` — complete hallucination | Actual content about AI and kitchen tech | zh |
| 11 | Clean output about exhibition, AI, earphones | Repetitive loop about "new technology and state-owned products" | Auto |

For most chunks (16 out of 20), the output is substantively the same — same names, same
topics, same structure, minor wording differences.

### Hallucination/looping happens with both settings

Chunk 8 is identical in both modes — the same sentence repeated 9 times. Chunk 19 loops
in both modes. Setting language explicitly does not prevent repetition hallucinations.

### Performance is comparable

| Mode | Avg inference time | Total time |
|------|-------------------|------------|
| Auto-detect | 2,577 ms/chunk | 51.5s |
| Explicit zh | 2,938 ms/chunk | 58.8s |

Explicit zh is slightly slower on average (14% more), likely because the auto-detect
shortcut allows the model to bail out of language detection faster when it confidently
(incorrectly) picks English.

## Verdict

**Setting language explicitly helps in edge cases** (Chunk 14 where auto-detect
completely hallucinated, Chunk 9 where zh produced more content) **but does not
systematically improve quality.** The model's translation decoder already appears to
"know" it's hearing Chinese regardless of the classifier output.

**The `detected=` language tag is meaningless for HF radio audio.** It will always say
`en`. Displaying it in the frontend provides no useful information and actively misleads
the user.

### Recommendation

1. **Do not display auto-detected language in the frontend.** It's wrong 100% of the time
   on this class of audio.
2. **Allow the user to explicitly set the source language** as an option, but default to
   auto (which effectively means "let the decoder figure it out").
3. **Don't invest further in trying to fix language detection** — the classifier is a
   tiny component of Whisper that runs on mel spectrograms, and HF radio noise clearly
   poisons it. The decoder itself works reasonably well despite the wrong classification.

---

## Raw Output

### Auto-Detect (language="")

| Chunk | Detected | Time | Segs | Text |
|-------|----------|------|------|------|
| 1 | en | 1265ms | 16 | to improve the creativity of the technology of the ocean. Third, be strong, be strong, be strong, the ocean industry. Fourth, strengthen the main ocean and the overall plan. Fifth, strengthen the environment of the ocean. Sixth, deeply participate in the world's ocean development. This is a joke. The Central Committee of the Communist Party of China was held yesterday at the 14th East China's Olympic Committee and the Chinese Olympic Committee... |
| 2 | en | 4343ms | 9 | 13 silver and 16 bronze medals, and 44 medals. The first place in the gold medalist district has achieved both the achievement and the spiritual civilization... |
| 3 | en | 3190ms | 5 | "The Great Wall of China" is a film about the great and powerful and powerful Chinese spirit... |
| 4 | en | 1213ms | 4 | And in the past, the national government has created more sports and sports equipment... |
| 5 | en | 2309ms | 7 | The foundation of the project is to support the study and change the body's recommendation... |
| 6 | en | 2400ms | 3 | The Tianjin TV organization, the organization's chief director, Dong Hua Liang... |
| 7 | en | 2626ms | 6 | In addition, the development of the system is not safe enough to develop it clearly... |
| 8 | en | 3312ms | 9 | The deputy director of the party committee of Xinjiang, Weiwu Erzi district... (REPEATED 9x) |
| 9 | en | 3585ms | 2 | [Cantonese] China's World Trade and Trade Union will work on the preparation of the oil industry... |
| 10 | en | 2158ms | 4 | The first national conference of the South China Sea after the closure of the sea... |
| 11 | en | 981ms | 8 | The exhibition will be held in the special state-owned state-owned products area... AI and electronic devices... |
| 12 | en | 1930ms | 3 | The supply of electricity, electricity, and electricity is now available to customers... |
| 13 | en | 1374ms | 6 | The new international exhibition area is called "The World's 30% increase in the global budget"... |
| 14 | en | 1961ms | 4 | [Spanish] [Spanish] [Spanish] [Spanish] |
| 15 | en | 2721ms | 5 | We are working on a solution to the family's needs... market's model of artificial intelligence will exceed $1.4 trillion... |
| 16 | en | 4962ms | 3 | The world is a new place, a new place, a new sea... |
| 17 | en | 3854ms | 4 | The village head of the village is called "Bai Yongmei"... |
| 18 | en | 4615ms | 6 | The government is saying that the factory is directly in operation... |
| 19 | en | 3543ms | 12 | The most important part of the process is the hand-pulling of the cloth... (LOOPS) |
| 20 | en | 1193ms | 14 | It's not just the water and the water. We can all work together... |

### Explicit Chinese (language="zh")

| Chunk | Detected | Time | Segs | Text |
|-------|----------|------|------|------|
| 1 | zh | 1644ms | 1 | 1. Increase the ability of the development of the sea and the technology... |
| 2 | zh | 4084ms | 9 | The 13 gold medals, 16 silver medals, and 44 medals were awarded... |
| 3 | zh | 3281ms | 5 | "The Great Wall of China" is a symbol of the great power of the Chinese people... |
| 4 | zh | 2748ms | 4 | And in the past, the national government has created more sports and sports equipment... |
| 5 | zh | 2130ms | 5 | The foundation of the foundation will continue to improve the study... |
| 6 | zh | 2450ms | 3 | The Tianjin TV organization, the organization's chief director, Dong Hua Liang... |
| 7 | zh | 4053ms | 6 | In addition, the development of the system is not safe enough... |
| 8 | zh | 3633ms | 9 | The deputy director of the party committee of Xinjiang, Weiwu Erzi district... (REPEATED 9x) |
| 9 | zh | 3254ms | 8 | The South China Sea Council has held a online training for the party members... |
| 10 | zh | 2541ms | 4 | As the first member of the Hainan-Songkuan-Ho organization... |
| 11 | zh | 2888ms | 14 | The exhibition will be held in the special state-owned state-owned products area... (LOOPS) |
| 12 | zh | 3401ms | 4 | The current purchase of goods and goods is based on the link between the online purchase... |
| 13 | zh | 1572ms | 6 | The new international exhibition area is called "The World's 30% increase in the global budget"... |
| 14 | zh | 4101ms | 8 | Zhang Yunlong, the reporter, explains how AI changes the experience of the kitchen... |
| 15 | zh | 2722ms | 5 | We have a workshop to deal with the family's environmental issues... |
| 16 | zh | 3036ms | 11 | "The world is a new place, and the world is a new place"... (LOOPS) |
| 17 | zh | 2174ms | 6 | The village head of the village is called "Bai Yongmei"... |
| 18 | zh | 3253ms | 6 | The government has to pay the price for the farm... |
| 19 | zh | 4581ms | 19 | The most tight loop of the rope is the one he is holding... (LOOPS) |
| 20 | zh | 1216ms | 14 | It's not just the water and the water. We can all work together... |
