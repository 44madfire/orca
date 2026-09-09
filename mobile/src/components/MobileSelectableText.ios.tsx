import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useMemo,
  type ReactNode
} from 'react'
import { StyleSheet, Text, UIManager, type TextProps, type TextStyle } from 'react-native'
import { UITextView } from 'react-native-uitextview'

// Older development clients can load this bundle before rebuilding their native views.
const hasRangeSelection = UIManager.hasViewManagerConfig('RNUITextView')
const NativeTextStyle = createContext<TextStyle | null>(null)

function flattenFragments(children: ReactNode): ReactNode[] {
  return (
    Children.map(children, (child) =>
      isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
        ? flattenFragments(child.props.children)
        : child
    ) ?? []
  )
}

export function MobileSelectableText({ children, style, ...props }: TextProps): React.JSX.Element {
  const inheritedStyle = useContext(NativeTextStyle)
  const textStyle = useMemo(
    () => StyleSheet.flatten([inheritedStyle, style]) ?? {},
    [inheritedStyle, style]
  )
  if (!hasRangeSelection || (!props.selectable && inheritedStyle === null)) {
    return (
      <Text {...props} style={style}>
        {children}
      </Text>
    )
  }

  // The native span adapter otherwise maps numeric bold to semibold.
  const nativeStyle =
    textStyle.fontWeight === '700' || textStyle.fontWeight === 700
      ? { ...textStyle, fontWeight: 'bold' as const }
      : textStyle
  return (
    <NativeTextStyle.Provider value={textStyle}>
      <UITextView {...props} uiTextView selectable style={nativeStyle}>
        {flattenFragments(children)}
      </UITextView>
    </NativeTextStyle.Provider>
  )
}
