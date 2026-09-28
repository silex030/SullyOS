# Nano-TTS 部署记录（VPS 手工维护，仓库只记契约）

- 服务：`moss-tts.service` → `/opt/moss-tts-nano/app_onnx.py --host 127.0.0.1 --port 18083 --cpu-threads 4 --max-new-frames 200`，conda env `moss`（py3.11）。
- 发音人：demo-30 = `prompt-voices/emo-calm.wav` + 已知转写（见 spec §2），`demo.jsonl` 追加行。
- 补丁：`moss` env 的 `sitecustomize.py` 把 `torchaudio.load` 换成 soundfile（sox 后端在此机段错误）。
- WeTextProcessing：pynini 先装再装本体；FST 一次性编译已缓存。
- 内存笼：`MemoryMax=5G`（复读循环曾 OOM 灭进程，坏请求灭服务单元，不威胁整机）。
- 回滚：停 moss-tts → git 重下 Genie → `/root/genie-tts.service.bak` 恢复（权重 2.2GB 重下）。
