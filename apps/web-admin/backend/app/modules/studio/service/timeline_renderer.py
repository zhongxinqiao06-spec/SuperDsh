"""按不可变工程快照渲染 MP4。子进程仅接触服务端生成的本地文件名。"""

import asyncio
import os
import shutil
import sys
import tempfile
from collections.abc import AsyncIterator
from importlib import import_module
from math import gcd
from pathlib import Path

from app.infrastructure.errors import DomainError
from app.modules.studio.entity.vo.studio_vo import Document


def timestamp(milliseconds: int) -> str:
    seconds, ms = divmod(milliseconds, 1000)
    minutes, sec = divmod(seconds, 60)
    hours, minute = divmod(minutes, 60)
    return f"{hours:02}:{minute:02}:{sec:02},{ms:03}"


def export_canvas(aspect: tuple[int, int]) -> tuple[int, int]:
    """沿用当前 720P 输出档，按作品画幅设置画布；不裁掉人物或拉伸参考镜头。"""
    width, height = aspect
    if width <= 0 or height <= 0:
        raise DomainError(422, "导出画幅无效，请检查作品规格")
    divisor = gcd(width, height)
    ratio = (width // divisor, height // divisor)
    supported = {
        (16, 9): (1280, 720),
        (9, 16): (720, 1280),
        (1, 1): (720, 720),
        (4, 3): (960, 720),
        (3, 4): (720, 960),
    }
    if ratio not in supported:
        raise DomainError(422, "当前导出支持横屏、竖屏、方形和 4:3 / 3:4 画幅")
    return supported[ratio]


class TimelineRenderer:
    def __init__(self, root: Path) -> None:
        self.root = root

    async def command(self, directory: Path, args: list[str]) -> None:
        executable = os.getenv("WEB_ADMIN_FFMPEG_EXECUTABLE") or shutil.which("ffmpeg")
        if not executable and sys.platform != "linux":
            executable = import_module("imageio_ffmpeg").get_ffmpeg_exe()
        if not executable:
            raise DomainError(503, "未找到 FFmpeg，请配置 WEB_ADMIN_FFMPEG_EXECUTABLE")
        process = await asyncio.create_subprocess_exec(
            executable,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            *args,
            cwd=directory,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            async with asyncio.timeout(300):
                if await process.wait():
                    raise DomainError(422, "媒体编码失败，请检查所采用的镜头和配音")
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def render(
        self,
        document: Document,
        target: Path,
        music: AsyncIterator[bytes] | None = None,
        *,
        aspect: tuple[int, int] = (16, 9),
    ) -> None:
        """先统一画幅、帧率及采样率再拼接，字幕相对裁剪点重新计算。"""
        width, height = export_canvas(aspect)
        if not document.shots or any(
            not s.candidate or any(not line.audio for line in s.lines) for s in document.shots
        ):
            raise DomainError(422, "每个镜头和台词均需采用候选后才能导出")
        self.root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.root) as workspace:
            directory = Path(workspace)
            segments: list[str] = []
            for index, shot in enumerate(document.shots):
                start, end = shot.trimStart, shot.trimEnd or shot.duration
                duration = (end - start) / 1000
                args = [
                    "-protocol_whitelist",
                    "file",
                    "-ss",
                    str(start / 1000),
                    "-i",
                    str(self.root / f"{shot.candidate}.mp4"),
                ]
                mix = ["[1:a]"]
                filters: list[str] = []
                subtitles: list[str] = []
                args += ["-f", "lavfi", "-t", str(duration), "-i", "anullsrc=r=48000:cl=stereo"]
                for line_index, line in enumerate(shot.lines):
                    relative = line.start - start
                    args += [
                        "-protocol_whitelist",
                        "file",
                        "-i",
                        str(self.root / f"{line.audio}.wav"),
                    ]
                    label = f"voice{line_index}"
                    filters.append(
                        f"[{line_index + 2}:a]atrim=start={max(0, -relative) / 1000},asetpts=PTS-STARTPTS,"
                        f"volume={line.volume},adelay={max(0, relative)}:all=1[{label}]"
                    )
                    mix.append(f"[{label}]")
                    subtitle = line.text if line.subtitle is None else line.subtitle
                    caption_start = line.start if line.subtitleStart is None else line.subtitleStart
                    begin, finish = (
                        max(0, caption_start - start),
                        min(end, line.end if line.end is not None else end) - start,
                    )
                    if subtitle and finish > begin:
                        subtitles.append(
                            f"{len(subtitles) + 1}\n{timestamp(begin)} --> {timestamp(finish)}\n{subtitle.replace(chr(10), ' ')}\n"
                        )
                vf = (
                    f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25"
                )
                if subtitles:
                    (directory / "captions.srt").write_text("\n".join(subtitles), encoding="utf-8")
                    vf += ",subtitles=captions.srt"
                filters.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0[audio]")
                segment = f"clip-{index}.mp4"
                await self.command(
                    directory,
                    args
                    + [
                        "-filter_complex",
                        ";".join(filters),
                        "-map",
                        "0:v:0",
                        "-map",
                        "[audio]",
                        "-vf",
                        vf,
                        "-t",
                        str(duration),
                        "-c:v",
                        "libx264",
                        "-pix_fmt",
                        "yuv420p",
                        "-preset",
                        "veryfast",
                        "-c:a",
                        "aac",
                        "-ar",
                        "48000",
                        "-ac",
                        "2",
                        segment,
                    ],
                )
                segments.append(f"file '{segment}'")
            (directory / "clips.txt").write_text("\n".join(segments), encoding="ascii")
            args = ["-protocol_whitelist", "file", "-f", "concat", "-safe", "1", "-i", "clips.txt"]
            if music is not None:
                with (directory / "music").open("wb") as target_music:
                    async for chunk in music:
                        await asyncio.to_thread(target_music.write, chunk)
                args += [
                    "-stream_loop",
                    "-1",
                    "-protocol_whitelist",
                    "file",
                    "-i",
                    "music",
                    "-filter_complex",
                    f"[1:a]volume={document.musicVolume}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[mix]",
                    "-map",
                    "0:v:0",
                    "-map",
                    "[mix]",
                    "-c:a",
                    "aac",
                    "-c:v",
                    "copy",
                ]
            else:
                args += ["-c", "copy"]
            await self.command(directory, args + ["-movflags", "+faststart", "film.mp4"])
            (directory / "film.mp4").replace(target)
