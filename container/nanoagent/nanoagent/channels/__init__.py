"""Chat channels module with plugin architecture."""

from nanoagent.channels.base import BaseChannel
from nanoagent.channels.manager import ChannelManager

__all__ = ["BaseChannel", "ChannelManager"]
