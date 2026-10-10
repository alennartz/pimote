/** Response payload for pimote's background-activity poll. */
export interface ActivityMessage {
  /** True when the responder asserts that closing the session would destroy live work. */
  active: boolean;
}
