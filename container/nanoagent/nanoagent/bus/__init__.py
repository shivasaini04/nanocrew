"""Message bus module for decoupled channel-agent communication."""

from nanoagent.bus.events import InboundMessage, OutboundMessage
from nanoagent.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
