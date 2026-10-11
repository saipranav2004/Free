#!/usr/bin/env python3
"""Composes the recorded screencast frames and overlays into one MP4.

    python3 scripts/video/compose.py <videoDir> <output.mp4>
"""
import json
import subprocess
import sys
from pathlib import Path

DIR = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/bitesip-video')
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else DIR / 'walkthrough.mp4')
FPS = 30
PHONE = dict(x=110, y=96, w=432, h=934)
KITCHEN = dict(x=640, y=168, w=1200, h=750)
tl = json.loads((DIR / 'timeline.json').read_text())


def run(cmd):
    print('$', ' '.join(str(c) for c in cmd)[:200])
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def pane(name, seg_start, seg_end, w, h):
    """Variable-rate screencast frames → constant 30 fps clip aligned to the segment start."""
    frames = json.loads((DIR / name / 'frames.json').read_text())
    lines = []
    for i, f in enumerate(frames):
        start = seg_start if i == 0 else f['t']
        end = frames[i + 1]['t'] if i + 1 < len(frames) else seg_end
        lines.append(f"file '{f['file']}'\nduration {max(end - start, 0.001):.4f}")
    lines.append(f"file '{frames[-1]['file']}'")
    lst = DIR / f'{name}.txt'
    lst.write_text('\n'.join(lines) + '\n')
    out = DIR / f'{name}.mp4'
    run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
         '-vf', f'fps={FPS},scale={w}:{h}:flags=lanczos,format=yuv420p',
         '-c:v', 'libx264', '-crf', '14', '-preset', 'fast', '-t', f'{seg_end - seg_start:.3f}', out])
    return out


def captions_for(segment, seg_start, seg_end):
    caps = [(i, c) for i, c in enumerate(tl['captions']) if c['segment'] == segment]
    spans = []
    for k, (i, c) in enumerate(caps):
        s = max(0.0, c['t'] - seg_start)
        e = (caps[k + 1][1]['t'] - seg_start) if k + 1 < len(caps) else (seg_end - seg_start)
        spans.append((DIR / f'cap-{i}.png', s, e))
    return spans


def overlay_captions(inputs, filters, last, spans, base_index):
    for j, (png, s, e) in enumerate(spans):
        idx = base_index + j
        inputs += ['-loop', '1', '-i', png]
        filters.append(
            f'[{idx}]format=rgba,fade=t=in:st={s:.2f}:d=0.3:alpha=1,fade=t=out:st={max(s, e - 0.3):.2f}:d=0.3:alpha=1[c{j}]')
        filters.append(f'[{last}][c{j}]overlay=0:0:shortest=1:enable=\'between(t,{s:.2f},{e:.2f})\'[o{j}]')
        last = f'o{j}'
    return last


def segment_a():
    s, e = tl['segA'], tl['segAEnd']
    dur = e - s
    student = pane('student', s, e, PHONE['w'], PHONE['h'])
    kitchen = pane('kitchen', s, e, KITCHEN['w'], KITCHEN['h'])
    inputs = ['-loop', '1', '-t', f'{dur:.3f}', '-i', DIR / 'bg-a.png', '-i', student, '-i', kitchen,
              '-loop', '1', '-i', DIR / 'frame-phone.png', '-loop', '1', '-i', DIR / 'frame-kitchen.png']
    f = [f"[0][1]overlay={PHONE['x']}:{PHONE['y']}[a1]",
         f"[a1][2]overlay={KITCHEN['x']}:{KITCHEN['y']}[a2]",
         '[a2][3]overlay=0:0:shortest=1[a3]', '[a3][4]overlay=0:0:shortest=1[a4]']
    last = overlay_captions(inputs, f, 'a4', captions_for('A', s, e), 5)
    f.append(f'[{last}]fade=t=in:st=0:d=0.4,fade=t=out:st={dur - 0.4:.2f}:d=0.4,format=yuv420p[v]')
    out = DIR / 'seg-a.mp4'
    run(['ffmpeg', '-y', *inputs, '-filter_complex', ';'.join(f), '-map', '[v]', '-t', f'{dur:.3f}',
         '-r', str(FPS), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', out])
    return out


def segment_b():
    s, e = tl['segB'], tl['segBEnd']
    dur = e - s
    owner = pane('owner', s, e, 1920, 1080)
    inputs = ['-i', owner]
    f = []
    last = overlay_captions(inputs, f, '0', captions_for('B', s, e), 1)
    f.append(f'[{last}]fade=t=in:st=0:d=0.4,fade=t=out:st={dur - 0.4:.2f}:d=0.4,format=yuv420p[v]')
    out = DIR / 'seg-b.mp4'
    run(['ffmpeg', '-y', *inputs, '-filter_complex', ';'.join(f), '-map', '[v]', '-t', f'{dur:.3f}',
         '-r', str(FPS), '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', out])
    return out


def card(name, dur):
    out = DIR / f'{name}.mp4'
    run(['ffmpeg', '-y', '-loop', '1', '-t', f'{dur}', '-i', DIR / f'{name}.png',
         '-vf', f'fps={FPS},zoompan=z=\'min(1+0.0006*on,1.04)\':d=1:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1920x1080:fps={FPS},'
                f'fade=t=in:st=0:d=0.5,fade=t=out:st={dur - 0.5}:d=0.5,format=yuv420p',
         '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', out])
    return out


parts = [card('card-title', 3.6), segment_a(), card('card-owner', 2.6), segment_b(), card('card-end', 3.6)]
lst = DIR / 'parts.txt'
lst.write_text(''.join(f"file '{p}'\n" for p in parts))
run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c:v', 'libx264', '-crf', '20', '-preset', 'slow',
     '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT])
print('wrote', OUT)
