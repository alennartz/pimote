import { ContextMenu } from 'bits-ui';
import Root from './context-menu.svelte';
import Content from './context-menu-content.svelte';
import Item from './context-menu-item.svelte';
import Portal from './context-menu-portal.svelte';

const { Trigger, Separator, Group, Sub, SubContent, SubTrigger, Arrow } = ContextMenu;

export {
  Root,
  Content,
  Item,
  Portal,
  Trigger,
  Separator,
  Group,
  Sub,
  SubContent,
  SubTrigger,
  Arrow,
  //
  Root as ContextMenu,
  Content as ContextMenuContent,
  Item as ContextMenuItem,
  Portal as ContextMenuPortal,
  Trigger as ContextMenuTrigger,
  Separator as ContextMenuSeparator,
  Group as ContextMenuGroup,
  Sub as ContextMenuSub,
  SubContent as ContextMenuSubContent,
  SubTrigger as ContextMenuSubTrigger,
  Arrow as ContextMenuArrow,
};
