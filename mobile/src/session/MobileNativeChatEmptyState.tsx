import { MobileSelectableText as Text } from '../components/MobileSelectableText'
import { View } from 'react-native'
import type { NativeChatEmptyStateCopy } from '../../../src/shared/native-chat-empty-state'
import { styles } from './mobile-native-chat-view-styles'

/** The centered copy shown when the transcript has no rows, mirroring desktop's
 *  `NativeChatEmptyState`. The subtitle carries the session error when the chat
 *  failed to load, so both lines are selectable. */
export function MobileNativeChatEmptyState({
  copy
}: {
  copy: NativeChatEmptyStateCopy
}): React.JSX.Element {
  return (
    <View style={styles.center}>
      <Text selectable style={styles.emptyTitle}>
        {copy.title}
      </Text>
      <Text selectable style={styles.emptySubtitle}>
        {copy.subtitle}
      </Text>
    </View>
  )
}
