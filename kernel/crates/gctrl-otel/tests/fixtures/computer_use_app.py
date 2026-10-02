#!/usr/bin/env python3
"""Native GUI fixture for disposable computer-use acceptance environments."""
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--name", required=True)
args = parser.parse_args()
# Gtk consumes its own --name argument while importing its overrides.
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title=f"gctrl acceptance {args.name}")
window.set_default_size(420, 180)
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
box.set_border_width(16)
window.add(box)
heading = Gtk.Label(label=args.name)
entry = Gtk.Entry()
entry.get_accessible().set_name("Message")
entry.set_placeholder_text("Message")
output = Gtk.Label(label="Ready")
output.get_accessible().set_name("Result")
button = Gtk.Button(label="Apply")
button.connect("clicked", lambda _: output.set_text(entry.get_text()))
for widget in (heading, entry, button, output):
    box.pack_start(widget, True, True, 0)
window.show_all()
Gtk.main()
