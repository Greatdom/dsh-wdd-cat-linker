export const name = 'hello-plugin'

export function apply() {
//注册相关插件,其中:

//当接收到消息之后缓存到池子里并向中转站返回到ack
//注册一个工具,这个工具强制让dsh输出成能够和InboundMessage组装成E:\程序代码\dsh\cat\src\main\java\com\wdd\cat\message\child\OutboundMessage.java的格式的json
// (当然并不是和真正的outboundMessage完全匹配,因为业务在回复完成后还要和原来的InboundMessage拼接成完整的数据结构)
//推理之前强制抹除原来的上下文及其历史并根据InboundMessage的内容注入新的提示词
//如果dsh在推理中检测到可能要调用到日程工具或者记忆工具,就要拦截掉并根据从中转站得到的渠道能力自行在json回复中追加送往特定渠道的消息
//例如如果模型推理检测到要加日程,那么在调用内置日程根据时根据代码被拦截并根据渠道能力表强制在json追加某个叫做INTERNAL_DATE的渠道的NormalMessage并入OutboundMessage
//最后将模型输出的json转换成期望的数据结构,先缓存到出站缓冲池,,接着送回中转站处理


}