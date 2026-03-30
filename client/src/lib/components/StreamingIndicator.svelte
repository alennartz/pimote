<div class="streaming-indicator">
  <span class="dot"></span>
  <span class="dot"></span>
  <span class="dot"></span>
</div>

<style>
  .streaming-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 8px 4px;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: var(--status-streaming, oklch(0.623 0.169 149.2));
    animation: pulse 1.4s ease-in-out infinite;
  }

  .dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes pulse {
    0%,
    80%,
    100% {
      opacity: 0.3;
      transform: scale(0.8);
    }
    40% {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
