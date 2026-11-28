#!/usr/bin/env python3
"""Regenerate fixtures/blocks-leds-vectors.json with blocksd 0.8.0 installed."""

import json
from importlib.metadata import version
from pathlib import Path

from blocksd.led.bitmap import Color
from blocksd.littlefoot.keys import key_led_program
from blocksd.littlefoot.lifecycle import KEY_RENDERER, RENDERER_READY_MARKER
from blocksd.protocol.builder import build_program_event
from blocksd.protocol.remote_heap import RemoteHeap


def main():
    if version("blocksd") != "0.8.0":
        raise SystemExit("Install blocksd==0.8.0 before regenerating these vectors.")

    index = 61
    initial_ack = 1022
    code = key_led_program()
    heap = RemoteHeap(7200)
    heap.handle_ack(initial_ack)

    def flush():
        packets = []
        while heap.is_dirty or heap.in_flight_count:
            while packet := heap.send_changes(index, now=0):
                packets.append(packet.hex())
            if not heap.in_flight_count:
                raise RuntimeError("Heap transfer stalled")
            heap.handle_ack((heap.packet_index - 1) & 0x3FF)
        return packets

    heap.set_bytes(0, code)
    upload = flush()
    frames = []
    colors = [[0, 0, 0] for _ in range(24)]
    for changes, brightness in [
        ({0: [255, 0, 0], 4: [0, 255, 0], 9: [0, 0, 255], 23: [40, 126, 201]}, 1),
        ({0: [0, 0, 0], 6: [255, 96, 24], 9: [48, 16, 0]}, 0.5),
    ]:
        for key, color in changes.items():
            colors[key] = color
        pixels = bytes(
            byte
            for color in colors
            for byte in Color(*(int(channel * brightness) for channel in color)).to_rgb565()
        )
        heap.set_bytes(len(code), pixels)
        frames.append(
            {
                "colors": colors.copy(),
                "brightness": brightness,
                "pixels": pixels.hex(),
                "packets": flush(),
            }
        )

    challenge = [RENDERER_READY_MARKER, KEY_RENDERER, 0x12345678]
    fixture = {
        "source": "blocksd 0.8.0",
        "index": index,
        "initialAck": initial_ack,
        "program": code.hex(),
        "upload": upload,
        "challenge": challenge,
        "challengePacket": build_program_event(index, tuple(challenge)).hex(),
        "frames": frames,
    }
    path = Path(__file__).with_name("fixtures") / "blocks-leds-vectors.json"
    path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
