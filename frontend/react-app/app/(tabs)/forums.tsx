import * as React from 'react';
import { useState } from 'react';

type Post = {
    id: number;
    content: string;
    comments: string[];
};

const Forum: React.FC = () => {
    const [posts, setPosts] = useState<Post[]>([]);
    const [newPostContent, setNewPostContent] = useState<string>('');

    const handlePostSubmit = () => {
        if (newPostContent.trim()) {
            const newPost: Post = {
                id: posts.length + 1,
                content: newPostContent,
                comments: []
            };
            setPosts([...posts, newPost]);
            setNewPostContent('');
        }
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <Text style={styles.title}>Forum</Text>
            <View style={}
        </ScrollView>
            /* <h1>Forum</h1>
            <div>
                <textarea
                    value={newPostContent}
                    onChange={(e) => setNewPostContent(e.target.value)}
                    placeholder="Write a new post..."
                />
                <button onClick={handlePostSubmit}>Post</button>
            </div>
            <div>
                {posts.map((post) => (
                    <div key={post.id}>
                        <h2>{post.content}</h2>
                        <div>
                            {post.comments.map((comment, index) => (
                                <p key={index}>{comment}</p>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    ); */}
};

export default Forum;